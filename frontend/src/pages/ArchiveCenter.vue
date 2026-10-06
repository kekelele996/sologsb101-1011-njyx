<script setup lang="ts">
/**
 * 流域整编中心：整编端自己留的那份档。
 * - 按测次号与测站报送档对上，收下成果回整编回执（写明采用定线参数与整编流量）
 * - 可驳回 / 撤回通过：只重发整编端这份，测站的垂线流速测点不动
 * - 认不出的旧档单列、只读保留
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, RefreshLeft, Stamp } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useArchiveStore, type ApproveInput } from '@/stores/archiveStore'
import { fitPowerCurve } from '@/types/rating'
import { DEVIATION_LIMIT_PCT } from '@/types/compare'
import { STATUS_TAG_TYPE, type CenterArchive, type RatingParams, type SubmissionArchive } from '@/types/submission'
import { initDatabase } from '@/utils/db'

const stationStore = useStationStore()
const archiveStore = useArchiveStore()

const statusFilter = ref<'全部' | '待整编' | '整编中' | '完成' | '驳回'>('全部')

const dialogVisible = ref(false)
const rejectVisible = ref(false)
const acting = ref(false)
const currentCenter = ref<CenterArchive | null>(null)

const form = reactive({
  editor: '整编室·何渠',
  lineNo: 'A',
  a: 0,
  b: 0,
  h0: 0,
  note: '',
  rejectReason: ''
})

const stationNameOf = (stationId: string): string =>
  stationStore.stationById(stationId)?.name ?? '未知测站'

const filteredCenters = computed(() =>
  statusFilter.value === '全部'
    ? archiveStore.activeCenters
    : archiveStore.activeCenters.filter((row) => row.status === statusFilter.value)
)

const stats = computed(() => ({
  total: archiveStore.activeCenters.length,
  pending: archiveStore.activeCenters.filter((row) => row.status === '待整编').length,
  processing: archiveStore.activeCenters.filter((row) => row.status === '整编中').length,
  done: archiveStore.activeCenters.filter((row) => row.status === '完成').length,
  rejected: archiveStore.activeCenters.filter((row) => row.status === '驳回').length,
  legacy: archiveStore.legacySubmissions.length
}))

/** 预填整编端采用参数：默认取测站报送时的拟合参数（不动参） */
function openApprove(center: CenterArchive): void {
  currentCenter.value = center
  const station = center.snapshot?.stationParams
  form.editor = '整编室·何渠'
  form.lineNo = station?.lineNo ?? 'A'
  form.a = station?.a ?? 0
  form.b = station?.b ?? 0
  form.h0 = station?.h0 ?? 0
  form.note = ''
  dialogVisible.value = true
}

function autoFit(): void {
  const center = currentCenter.value
  if (!center) return
  // 整编端可用该站当前全部关系点据重新拟合一组参数（动参的依据）
  const points = archiveStore.ratings
    .filter((rating) => rating.stationId === center.stationId && rating.lineNo === form.lineNo)
    .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s }))
  const fit = fitPowerCurve(points, form.lineNo)
  if (!fit.valid) {
    ElMessage.warning(fit.message || '点据不足，无法重新定线')
    return
  }
  form.a = fit.a
  form.b = fit.b
  form.h0 = fit.h0
  ElMessage.success(`已按 ${form.lineNo} 线 ${fit.sampleCount} 个点据重算参数`)
}

/** 表单参数实时预估整编流量 / 残差 / 结论 */
const preview = computed(() => {
  const center = currentCenter.value
  if (!center?.snapshot || !form.a || form.b <= 0) return null
  const rated = Number(
    (form.a * Math.pow(Math.max(center.snapshot.stageM - form.h0, 1e-6), form.b)).toFixed(2)
  )
  const residual = center.snapshot.measuredFlow
    ? Number((((rated - center.snapshot.measuredFlow) / center.snapshot.measuredFlow) * 100).toFixed(2))
    : 0
  return {
    rated,
    residual,
    verdict: Math.abs(residual) > DEVIATION_LIMIT_PCT ? '超限' : '合格',
    changed:
      !!center.snapshot.stationParams &&
      (Math.abs(center.snapshot.stationParams.a - form.a) > 1e-4 ||
        Math.abs(center.snapshot.stationParams.b - form.b) > 1e-3 ||
        Math.abs(center.snapshot.stationParams.h0 - form.h0) > 1e-3)
  }
})

async function submitApprove(): Promise<void> {
  const center = currentCenter.value
  if (!center) return
  if (!form.a || form.a <= 0 || form.b <= 0) {
    ElMessage.warning('请填写有效的定线参数：a > 0、b > 0')
    return
  }
  acting.value = true
  try {
    const params: RatingParams = { lineNo: form.lineNo, a: form.a, b: form.b, h0: form.h0 }
    const payload: ApproveInput = {
      centerId: center.id,
      editor: form.editor,
      adoptedParams: params,
      note: form.note.trim()
    }
    const { receipt, changed } = await archiveStore.approveAtCenter(payload)
    ElMessage.success(
      `回执 ${receipt.receiptNo} 已回送测站，整编流量 ${receipt.ratedFlow} m³/s` +
        (changed ? '；定线参数有调整，测站将按新参数重算曲线流量、残差与比测结论' : '')
    )
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '回执出具失败')
  } finally {
    acting.value = false
  }
}

function openReject(center: CenterArchive): void {
  currentCenter.value = center
  form.editor = '整编室·何渠'
  form.rejectReason = ''
  rejectVisible.value = true
}

async function submitReject(): Promise<void> {
  const center = currentCenter.value
  if (!center) return
  if (!form.rejectReason.trim()) {
    ElMessage.warning('请填写驳回理由（只重发整编端这份，测站垂线测点保留）')
    return
  }
  acting.value = true
  try {
    await archiveStore.rejectAtCenter(center.id, form.editor, form.rejectReason)
    ElMessage.success('已驳回并通知测站重报；测站垂线与流速测点未改动')
    rejectVisible.value = false
  } finally {
    acting.value = false
  }
}

async function withdraw(center: CenterArchive): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('撤回该回执？测次将退回整编中，测站垂线流速测点照旧保留。', '撤回回执', {
      confirmButtonText: '撤回',
      cancelButtonText: '取消',
      inputPlaceholder: '撤回原因（可选）',
      inputValue: ''
    })
    await archiveStore.withdrawAtCenter(center.id, '整编室·何渠', String(value ?? ''))
    ElMessage.success('回执已撤回，只重发了整编端这份')
  } catch (error) {
    if (error instanceof Error) ElMessage.error(error.message)
  }
}

function formatParams(params: RatingParams | null): string {
  if (!params) return '—'
  if (params.a === 0 && params.b === 0 && params.h0 === 0) return '参数不可考'
  return `Q=${params.a}·(H-${params.h0})^${params.b}`
}

onMounted(() => {
  stationStore.start()
  archiveStore.start()
  if (stationStore.stations.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!archiveStore.ready" :rows="6" animated />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item>流域整编中心</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            流域整编中心 · 成果报整编辑档
            <el-tag size="small" effect="plain">按测次号对档</el-tag>
          </h2>
          <p class="gb-hint">
            整编端与测站各留各的档：收下测流成果后回整编回执，写明采用的定线参数与整编流量；驳回或撤回只重发本侧那份，测站垂线与流速测点不动。
          </p>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="在档测次" :value="stats.total" suffix="个" icon="Files" />
        <StatBadge label="待整编" :value="stats.pending" suffix="个" tone="warning" icon="Bell" />
        <StatBadge label="整编中" :value="stats.processing" suffix="个" tone="info" icon="Loading" />
        <StatBadge label="已完成" :value="stats.done" suffix="个" tone="success" icon="CircleCheck" />
        <StatBadge label="已驳回" :value="stats.rejected" suffix="个" tone="danger" icon="CircleClose" />
        <StatBadge label="认不出旧档" :value="stats.legacy" suffix="份" icon="Lock" />
      </div>

      <el-radio-group v-model="statusFilter" size="small">
        <el-radio-button v-for="value in ['全部', '待整编', '整编中', '完成', '驳回']" :key="value" :value="value">
          {{ value }}
        </el-radio-button>
      </el-radio-group>

      <EmptyPanel
        v-if="filteredCenters.length === 0"
        title="整编端没有该状态的成果档"
        description="测站在断面测次页点「报整编」后，成果会按测次号送到这里。"
        compact
      />

      <el-table v-else :data="filteredCenters" border stripe class="gb-table-compact">
        <el-table-column prop="measureNo" label="测次号" min-width="140" />
        <el-table-column label="测站" min-width="130">
          <template #default="{ row }">{{ stationNameOf(row.stationId) }}</template>
        </el-table-column>
        <el-table-column label="测法" width="90">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.method }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="报送次数" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" round>{{ row.reportSeq }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.snapshot?.stageM.toFixed(2) ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量 (m³/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.snapshot?.measuredFlow.toFixed(2) ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="整编参数 / 整编流量" min-width="230">
          <template #default="{ row }">
            <div v-if="row.receipt" class="page__receipt">
              <span class="gb-mono">{{ formatParams(row.receipt.adoptedParams) }}</span>
              <span class="gb-mono page__flow">→ {{ row.receipt.ratedFlow }} m³/s</span>
              <el-tag size="small" :type="row.receipt.paramsChanged ? 'warning' : 'success'" effect="plain">
                {{ row.receipt.paramsChanged ? '动过参数' : '未动参数' }}
              </el-tag>
            </div>
            <span v-else class="gb-hint">尚未出具回执</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }: { row: CenterArchive }">
            <el-tag size="small" :type="STATUS_TAG_TYPE[row.status]">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="最近报送" min-width="160">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.lastReceivedAt ? new Date(row.lastReceivedAt).toLocaleString('zh-CN') : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === '待整编' || row.status === '整编中' || row.status === '驳回'"
              size="small"
              type="primary"
              :icon="Stamp"
              @click="openApprove(row)"
            >
              出回执
            </el-button>
            <el-button
              v-if="row.status === '待整编' || row.status === '整编中'"
              size="small"
              type="danger"
              plain
              @click="openReject(row)"
            >
              驳回
            </el-button>
            <el-button
              v-if="row.status === '完成'"
              size="small"
              :icon="RefreshLeft"
              @click="withdraw(row)"
            >
              撤回
            </el-button>
          </template>
        </el-table-column>
        <template #expand="{ row }">
          <div class="page__expand">
            <p v-if="row.snapshot" class="gb-hint">
              成果快照：垂线 {{ row.snapshot.verticalCount }} 条 · 测点 {{ row.snapshot.pointCount }} 点 ·
              断面面积 {{ row.snapshot.areaM2 }} m² · 平均流速 {{ row.snapshot.meanVelocityMs }} m/s ·
              测站报送参数 {{ formatParams(row.snapshot.stationParams) }}
            </p>
            <el-descriptions v-if="row.receipt" :column="2" border size="small" title="整编回执">
              <el-descriptions-item label="回执编号">{{ row.receipt.receiptNo }}</el-descriptions-item>
              <el-descriptions-item label="回执时间">
                {{ new Date(row.receipt.receiptAt).toLocaleString('zh-CN') }}
              </el-descriptions-item>
              <el-descriptions-item label="整编员">{{ row.receipt.editor }}</el-descriptions-item>
              <el-descriptions-item label="比测结论">
                <el-tag size="small" :type="row.receipt.verdict === '合格' ? 'success' : 'danger'">
                  {{ row.receipt.verdict }}（残差 {{ row.receipt.residualPct }}%）
                </el-tag>
              </el-descriptions-item>
              <el-descriptions-item label="整编意见" :span="2">{{ row.receipt.note || '—' }}</el-descriptions-item>
            </el-descriptions>
            <el-timeline v-if="row.remarks.length > 0" class="page__timeline">
              <el-timeline-item
                v-for="(remark, index) in row.remarks"
                :key="index"
                :timestamp="`${remark.editor} · ${new Date(remark.at).toLocaleString('zh-CN')}`"
              >
                {{ remark.note }}
              </el-timeline-item>
            </el-timeline>
          </div>
        </template>
      </el-table>

      <!-- 认不出的旧档：单列、只读保留 -->
      <div class="gb-panel">
        <div class="gb-panel-title">
          <h3>认不出的旧档（只读保留）</h3>
          <span class="gb-hint">升级回填时对不上测次的历史报送记录，只可查看，不参与整编流转</span>
        </div>
        <el-table :data="archiveStore.legacySubmissions" border size="small" class="gb-table-compact">
          <el-table-column prop="measureNo" label="测次号" min-width="150" />
          <el-table-column label="水位 (m)" width="110" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.snapshot?.stageM.toFixed(2) ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="实测流量 (m³/s)" width="150" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.snapshot?.measuredFlow.toFixed(2) ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="回填回执" min-width="200">
            <template #default="{ row }">
              <template v-if="row.receipt">
                <el-tag size="small" type="success" effect="plain" :icon="CircleCheck">
                  {{ row.receipt.receiptNo }} · {{ row.receipt.verdict }}
                </el-tag>
                <span class="gb-hint">（{{ row.receipt.note }}）</span>
              </template>
              <span v-else class="gb-hint">无回执，按待整编回填</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100" align="center">
            <template #default="{ row }: { row: SubmissionArchive }">
              <el-tag size="small" :type="STATUS_TAG_TYPE[row.status]" effect="plain">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <!-- 出具回执：整编端写明采用定线参数与整编流量 -->
    <el-dialog v-model="dialogVisible" title="出具整编回执" width="600px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="整编员">
          <el-input v-model="form.editor" placeholder="整编员姓名" />
        </el-form-item>
        <el-form-item label="定线号">
          <el-input v-model="form.lineNo" maxlength="4" style="width: 120px" />
          <el-button class="page__fit-btn" size="small" @click="autoFit">按本站点据重算参数</el-button>
        </el-form-item>
        <el-form-item label="系数 a">
          <el-input-number v-model="form.a" :step="0.1" :precision="4" controls-position="right" />
        </el-form-item>
        <el-form-item label="指数 b">
          <el-input-number v-model="form.b" :step="0.01" :precision="3" controls-position="right" />
        </el-form-item>
        <el-form-item label="基线 H0 (m)">
          <el-input-number v-model="form.h0" :step="0.01" :precision="3" controls-position="right" />
        </el-form-item>
        <el-alert
          v-if="preview"
          class="page__preview"
          :type="preview.verdict === '合格' ? 'success' : 'error'"
          :closable="false"
          show-icon
          :title="`整编流量 ${preview.rated} m³/s · 残差 ${preview.residual}% · ${preview.verdict}（限值 ${DEVIATION_LIMIT_PCT}%）${preview.changed ? ' · 相对测站参数有调整' : ''}`"
        />
        <el-form-item label="整编意见">
          <el-input v-model="form.note" type="textarea" :rows="2" maxlength="120" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="acting" :icon="Stamp" @click="submitApprove">回送回执</el-button>
      </template>
    </el-dialog>

    <!-- 驳回：只重发整编端那份 -->
    <el-dialog v-model="rejectVisible" title="驳回成果（只重发整编端这份）" width="520px" :close-on-click-modal="false">
      <el-form label-width="90px">
        <el-form-item label="整编员">
          <el-input v-model="form.editor" />
        </el-form-item>
        <el-form-item label="驳回理由" required>
          <el-input v-model="form.rejectReason" type="textarea" :rows="3" maxlength="120" show-word-limit />
        </el-form-item>
        <p class="gb-hint">驳回后测次退回待重报；测站的垂线布设与流速测点照旧保留，不做任何改动。</p>
      </el-form>
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="acting" @click="submitReject">确认驳回</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0f4c75;
}

.page__receipt {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.page__flow {
  color: #0f4c75;
  font-weight: 600;
}

.page__expand {
  padding: 4px 12px 8px;
}

.page__timeline {
  margin-top: 10px;
}

.page__fit-btn {
  margin-left: 10px;
}

.page__preview {
  margin: 0 0 12px 110px;
}
</style>
