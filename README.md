# sologsb101-1011 水文站流量测验与绳套曲线台

面向水文站测验与资料整编人员的纯前端单页应用：把每次测流的测站、断面测次、垂线测深、流速测点逐层落档，据此整理水位—流量关系点据完成幂函数定线，并开展比测偏差分析。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22811**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22811），如需换端口改这一个变量即可。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `stationStore` / `sectionStore` / `ratingStore` |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbhydrogaug`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 测站台账 | Station、Section、Rating | 新建/编辑/删除测站，按河名与集水面积分档筛选，卡片回显测次数、最新水位与比测合格率 |
| `/stations/:id/sections` | 断面测次列表与测法标记 | Section、Station、SubmissionArchive | 新增测次（测次号、起点距、水位、流速仪/浮标/ADCP），水位筛选，回显当前水位与水位变幅；**报整编 / 重报、整编状态与整编回执查看** |
| `/sections/:id/verticals` | 垂线布设与测深 | Vertical、Section、SubmissionArchive | 起点距排序校验（重复即时告警）、按测点数自动生成测点行、部分面积法断面流量成果；回执完成后改动垂线会提示回执作废 |
| `/verticals/:id/points` | 流速测点录入 | Point、Vertical、SubmissionArchive | 逐点录入相对水深与流速、批量粘贴导入、批量改写流速、权重归一、垂线流速分布图；改动测点联动作废回执 |
| `/ratings` | 水位流量关系点据与定线 | Rating、Compare | 幂函数定线 Q=a(H-H0)^b（自动搜索基线并给出 R²、平均/最大残差）、超限点挂红、关系曲线绘制 |
| `/center` | 流域整编中心 | CenterArchive、SubmissionArchive、Compare | 按测次号对档收下成果、出具整编回执（写明采用定线参数与整编流量）、驳回 / 撤回只重发整编端这份、认不出旧档只读保留 |
| `/export` | 比测偏差分析与导出 | 全部模型 | 按测站出检测结论、比测偏差分析清单、全量 JSON 导入导出、清空重建演示数据 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1011/
├── README.md
├── docker-compose.yml          # name: gbhydrogaug，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # station / section / vertical / point / rating / compare / filter / submission
        ├── stores/             # stationStore / sectionStore / ratingStore / archiveStore
        ├── components/common/  # DeviationTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useRatingFit
        ├── pages/              # StationList / SectionList / VerticalBoard / PointEntry / RatingChart / ArchiveCenter / ExportView
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # flow.ts（流量计算）/ db.ts（Dexie 封装）/ export.ts（导入导出）/ submissionFlow.ts（报整编业务）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22811
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbhydrogaug`，当前结构版本 `v3`。页面侧由 `frontend/src/utils/db.ts` 统一封装，页面组件不直接触碰 Dexie 实例。
- **数据表**：`stations`（测站）、`sections`（断面测次）、`verticals`（垂线）、`points`（流速测点）、`ratings`（水位流量关系点据）、`compares`（比测记录）、`submissions`（测站侧报送档）、`centerArchives`（整编端档）。
- **测流成果报整编流程**：
  - 测站在断面测次页把成果报去流域整编中心，**测站与整编端各留各的档**（`submissions` / `centerArchives`），两边按**测次号**对上；报送时冻结成果快照（水位、实测流量、垂线 / 测点数、测站拟合参数）。
  - 整编端在 `/center` 收下成果后回一份**整编回执**，写明采用的定线参数（a、b、H0）与整编流量、残差、比测结论；**回执到了该测次才算「完成」**。
  - 回执里**动过定线参数**的，测站按整编端参数**重算曲线流量、残差与比测结论**（`recomputeWithParams`），并同步该测次的比测记录。
  - 测站在回执后**又改动垂线或流速测点**，原回执自动**作废**（`receiptVoided`），测次**退回待整编**，重报后按新回执走；作废回执仍留痕。
  - 整编端**驳回或撤回**时只重发整编端这份档（追加 `remarks`），测站的垂线、流速测点照旧保留，重报后 `reportSeq` 递增。
  - **旧数据升级**：旧数据没有报整编标识，v3 升级按「有没有回执」回填报送状态；关系点据里存在但对不上测次号的旧记录，单列为 `legacyUnmatched` **只读保留**（整编中心页底部展示），不参与任何流转。
- **升级迁移**：`db.version(1)` 保留初版结构，`db.version(2)` 补齐索引并回填历史数据缺失的时间戳与判定结论，`db.version(3)` 新增 `submissions` / `centerArchives` 两张报送档表并回填旧数据；调整字段结构时递增 `DB_VERSION` 并在 `upgrade` 中补迁移。
- **首屏播种**：`initDatabase()` 在 `stations` 表为空时执行幂等播种，生成三层互相引用的演示数据（3 个测站 / 5 个断面测次 / 8 条垂线 / 26 个流速测点 / 13 个关系点据 / 13 条比测记录 / 5 对报送档 + 3 份认不出旧档），报送档覆盖完成（未动参 / 动过参）、整编中、驳回、回执作废待整编等全部流转状态；关系点据 C 线含 2 个超限点据用于演示挂红与偏差分析。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，store 里的列表自动刷新，无需手动处理刷新时机。
- **备份与恢复**：`/export` 页可导出包含八张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id）」两种模式；旧版六表备份缺两张报送档表时按空数组兼容导入；备份时间写入 `localStorage`。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器 / 清空站点数据后数据不会跟随，需通过 JSON 备份迁移。
