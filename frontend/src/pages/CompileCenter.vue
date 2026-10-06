<script setup lang="ts">
/**
 * 整编中心（整编端）：受理测站报来的测流成果，出具整编回执。
 * 回执写明采用的定线参数（a / b / H0）与整编流量；动过参数的，测站按回执参数重算。
 * 驳回或撤回只重发本侧那份，测站垂线流速测点照旧留着。
 */
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, CircleCheckFilled, Clock, Promotion, Refresh, RefreshLeft, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import CompileStatusTag from '@/components/common/CompileStatusTag.vue'
import { useCompileStore } from '@/stores/compileStore'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useRatingStore } from '@/stores/ratingStore'
import { fitPowerCurve, curveFlow, type RatingFitResult } from '@/types/rating'
import type { Section } from '@/types/section'
import type { Receipt } from '@/types/receipt'
import { initDatabase } from '@/utils/db'

const compileStore = useCompileStore()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const ratingStore = useRatingStore()

const activeTab = ref<'queue' | 'completed' | 'legacy'>('queue')
const receiptDialogVisible = ref(false)
const currentSection = ref<Section | null>(null)
const submitting = ref(false)

/** 回执表单：整编端采用的定线参数 */
const form = reactive({
  lineNo: 'A',
  a: 0,
  b: 0,
  h0: 0,
  operator: '整编中心·林昭',
  note: ''
})

/** 当前测次对应的自动定线（按测次号找到点据的定线号） */
const autoFit = computed<RatingFitResult | null>(() => {
  if (!currentSection.value) return null
  const rating = ratingStore.ratings.find((item) => item.measureNo === currentSection.value!.measureNo)
  if (!rating) return null
  const points = ratingStore.ratings
    .filter((item) => item.lineNo === rating.lineNo)
    .map((item) => ({ stageM: item.stageM, flowM3s: item.flowM3s }))
  return fitPowerCurve(points, rating.lineNo)
})

/** 按当前采用参数推求的整编流量 */
const compiledFlow = computed(() => {
  if (!currentSection.value || !form.a || !form.b) return 0
  const fit: RatingFitResult = {
    lineNo: form.lineNo,
    a: form.a,
    b: form.b,
    h0: form.h0,
    sampleCount: autoFit.value?.sampleCount ?? 0,
    meanResidualPct: autoFit.value?.meanResidualPct ?? 0,
    maxResidualPct: autoFit.value?.maxResidualPct ?? 0,
    r2: 0,
    valid: true,
    message: ''
  }
  return curveFlow(fit, currentSection.value.stageM)
})

const queue = computed(() => compileStore.compileQueue)
const completed = computed(() => compileStore.completedSections)
const legacy = computed(() => compileStore.legacySections)

const stats = computed(() => ({
  queue: queue.value.length,
  completed: completed.value.length,
  legacy: legacy.value.length
}))

function stationNameOf(stationId: string): string {
  return stationStore.stationById(stationId)?.name ?? '未知测站'
}

/** 打开回执出具弹窗：自动带入定线参数 */
function openReceipt(section: Section): void {
  currentSection.value = section
  const rating = ratingStore.ratings.find((item) => item.measureNo === section.measureNo)
  form.lineNo = rating?.lineNo ?? 'A'
  const fit = autoFit.value
  if (fit?.valid) {
    form.a = fit.a
    form.b = fit.b
    form.h0 = fit.h0
  } else {
    form.a = 0
    form.b = 0
    form.h0 = 0
  }
  form.operator = '整编中心·林昭'
  form.note = ''
  receiptDialogVisible.value = true
}

/** 受理：出具回执 */
async function handleAccept(): Promise<void> {
  if (!currentSection.value) return
  if (!form.a || !form.b) {
    ElMessage.warning('请填写采用的定线参数 a 与 b')
    return
  }
  submitting.value = true
  try {
    const fit = autoFit.value
    await compileStore.issueReceipt(currentSection.value.id, {
      lineNo: form.lineNo,
      a: form.a,
      b: form.b,
      h0: form.h0,
      compiledFlowM3s: compiledFlow.value,
      meanResidualPct: fit?.meanResidualPct ?? 0,
      maxResidualPct: fit?.maxResidualPct ?? 0,
      sampleCount: fit?.sampleCount ?? 0,
      operator: form.operator,
      note: form.note
    })
    ElMessage.success(`已出具受理回执，测次 ${currentSection.value.measureNo} 整编完成`)
    receiptDialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

/** 驳回：只重发本侧那份 */
async function handleReject(): Promise<void> {
  if (!currentSection.value) return
  const { value: note } = await ElMessageBox.prompt('请填写驳回原因（测站垂线流速测点照旧留着）', '驳回确认', {
    confirmButtonText: '确认驳回',
    cancelButtonText: '取消',
    inputType: 'textarea',
    inputPlaceholder: '如：浮标法系数偏大，请复核后重报'
  })
  await compileStore.rejectReceipt(currentSection.value.id, note, form.operator)
  ElMessage.success('已出具驳回回执，测次退回待整编')
  receiptDialogVisible.value = false
}

/** 撤回：只重发本侧那份 */
async function handleWithdraw(): Promise<void> {
  if (!currentSection.value) return
  const { value: note } = await ElMessageBox.prompt('请填写撤回原因（测站垂线流速测点照旧留着）', '撤回确认', {
    confirmButtonText: '确认撤回',
    cancelButtonText: '取消',
    inputType: 'textarea',
    inputPlaceholder: '如：定线参数需复核，暂撤回'
  })
  await compileStore.withdrawReceipt(currentSection.value.id, note, form.operator)
  ElMessage.success('已出具撤回回执，测次退回待整编')
  receiptDialogVisible.value = false
}

/** 查看某测次的回执历史 */
function viewReceiptHistory(section: Section): void {
  const receipts = compileStore.receiptsOfSection(section.id)
  if (receipts.length === 0) {
    ElMessage.info('该测次暂无回执')
    return
  }
  currentSection.value = section
  receiptDialogVisible.value = true
}

function receiptType(tag: string): 'success' | 'danger' | 'warning' | 'info' {
  if (tag === 'accepted') return 'success'
  if (tag === 'rejected') return 'danger'
  if (tag === 'withdrawn') return 'warning'
  return 'info'
}

function receiptLabel(tag: string): string {
  if (tag === 'accepted') return '受理'
  if (tag === 'rejected') return '驳回'
  if (tag === 'withdrawn') return '撤回'
  return '作废'
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  compileStore.start()
  sectionStore.start()
  ratingStore.start()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">整编中心</h2>
        <p class="gb-hint">
          整编端受理测站报来的测流成果，出具整编回执（采用的定线参数与整编流量）。回执到了测次才算完成；动过参数的，测站按回执重算曲线流量、残差与比测结论。
        </p>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="待受理" :value="stats.queue" suffix="测次" tone="warning" icon="Promotion" />
      <StatBadge label="已完成" :value="stats.completed" suffix="测次" tone="success" icon="CircleCheckFilled" />
      <StatBadge label="历史遗留" :value="stats.legacy" suffix="测次" tone="info" icon="Clock" />
    </div>

    <el-tabs v-model="activeTab" class="page__tabs">
      <el-tab-pane name="queue">
        <template #label>
          <span><el-icon><Promotion /></el-icon> 待受理 <el-badge v-if="stats.queue" :value="stats.queue" class="page__tab-badge" /></span>
        </template>
        <EmptyPanel
          v-if="queue.length === 0"
          title="暂无待受理测次"
          description="测站报整编后，测流成果会出现在这里等待出具回执。"
          compact
        />
        <el-table v-else :data="queue" border stripe class="gb-table-compact">
          <el-table-column label="测次号" min-width="150">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.measureNo }}</span>
            </template>
          </el-table-column>
          <el-table-column label="测站" min-width="140">
            <template #default="{ row }">{{ stationNameOf(row.stationId) }}</template>
          </el-table-column>
          <el-table-column label="水位 (m)" width="110" align="right">
            <template #default="{ row }"><span class="gb-mono">{{ row.stageM.toFixed(2) }}</span></template>
          </el-table-column>
          <el-table-column label="测法" width="90">
            <template #default="{ row }"><el-tag size="small" effect="plain">{{ row.method }}</el-tag></template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }"><CompileStatusTag :status="row.compileStatus" /></template>
          </el-table-column>
          <el-table-column label="报整编时间" min-width="170">
            <template #default="{ row }"><span class="gb-mono">{{ new Date(row.updatedAt).toLocaleString('zh-CN') }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="160" fixed="right">
            <template #default="{ row }">
              <el-button size="small" type="primary" :icon="Check" @click="openReceipt(row)">出具回执</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane name="completed">
        <template #label>
          <span><el-icon><CircleCheckFilled /></el-icon> 已完成</span>
        </template>
        <EmptyPanel
          v-if="completed.length === 0"
          title="暂无已完成测次"
          description="出具受理回执后，测次整编完成并出现在这里。"
          compact
        />
        <el-table v-else :data="completed" border stripe class="gb-table-compact">
          <el-table-column label="测次号" min-width="150">
            <template #default="{ row }"><span class="gb-mono">{{ row.measureNo }}</span></template>
          </el-table-column>
          <el-table-column label="测站" min-width="140">
            <template #default="{ row }">{{ stationNameOf(row.stationId) }}</template>
          </el-table-column>
          <el-table-column label="采用定线" width="100" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ compileStore.latestReceiptOfSection(row.id)?.lineNo ?? '—' }} 线</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="整编流量 (m³/s)" width="140" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ compileStore.latestReceiptOfSection(row.id)?.compiledFlowM3s.toFixed(1) ?? '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }"><CompileStatusTag :status="row.compileStatus" /></template>
          </el-table-column>
          <el-table-column label="操作" width="140" fixed="right">
            <template #default="{ row }">
              <el-button size="small" :icon="Refresh" @click="viewReceiptHistory(row)">回执历史</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane name="legacy">
        <template #label>
          <span><el-icon><Clock /></el-icon> 历史遗留 <el-badge v-if="stats.legacy" :value="stats.legacy" type="info" class="page__tab-badge" /></span>
        </template>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="升级时认不出归属的测次（测站已不存在或引用断裂）单列只读保留，不可编辑或报整编。"
          class="page__legacy-alert"
        />
        <EmptyPanel
          v-if="legacy.length === 0"
          title="没有历史遗留测次"
          description="升级时所有测次都能认出归属，无需只读保留。"
          compact
        />
        <el-table v-else :data="legacy" border stripe class="gb-table-compact">
          <el-table-column label="测次号" min-width="150">
            <template #default="{ row }"><span class="gb-mono">{{ row.measureNo }}</span></template>
          </el-table-column>
          <el-table-column label="水位 (m)" width="110" align="right">
            <template #default="{ row }"><span class="gb-mono">{{ row.stageM.toFixed(2) }}</span></template>
          </el-table-column>
          <el-table-column label="测法" width="90">
            <template #default="{ row }"><el-tag size="small" effect="plain">{{ row.method }}</el-tag></template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }"><el-tag size="small" type="info" effect="plain">只读</el-tag></template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- 回执出具弹窗 -->
    <el-dialog
      v-model="receiptDialogVisible"
      :title="currentSection ? `整编回执 · 测次 ${currentSection.measureNo}` : '整编回执'"
      width="720px"
      :close-on-click-modal="false"
    >
      <template v-if="currentSection">
        <el-descriptions :column="3" border size="small" class="page__receipt-meta">
          <el-descriptions-item label="测次号">{{ currentSection.measureNo }}</el-descriptions-item>
          <el-descriptions-item label="测站">{{ stationNameOf(currentSection.stationId) }}</el-descriptions-item>
          <el-descriptions-item label="水位">{{ currentSection.stageM.toFixed(2) }} m</el-descriptions-item>
          <el-descriptions-item label="测法">{{ currentSection.method }}</el-descriptions-item>
          <el-descriptions-item label="垂线 / 测点">
            {{ sectionStore.sectionVerticalCounts[currentSection.id] ?? 0 }} 条 /
            {{ sectionStore.verticals.filter((v) => v.sectionId === currentSection!.id).reduce((s, v) => s + v.pointCount, 0) }} 点
          </el-descriptions-item>
          <el-descriptions-item label="自动定线">
            <span v-if="autoFit?.valid">{{ autoFit.lineNo }} 线 · 平均残差 {{ autoFit.meanResidualPct }}%</span>
            <span v-else class="page__warn">点据不足，无法自动定线</span>
          </el-descriptions-item>
        </el-descriptions>

        <el-alert
          type="warning"
          show-icon
          :closable="false"
          title="回执动过定线参数的，测站按回执参数重算曲线流量、残差与比测结论。"
          class="page__receipt-alert"
        />

        <el-form label-width="120px" class="page__receipt-form">
          <el-form-item label="采用定线号">
            <el-input v-model="form.lineNo" maxlength="8" class="page__line-no" />
          </el-form-item>
          <el-form-item label="系数 a">
            <el-input-number v-model="form.a" :min="0" :step="0.0001" :precision="4" controls-position="right" />
          </el-form-item>
          <el-form-item label="指数 b">
            <el-input-number v-model="form.b" :min="0" :step="0.001" :precision="3" controls-position="right" />
          </el-form-item>
          <el-form-item label="基线 H0 (m)">
            <el-input-number v-model="form.h0" :step="0.001" :precision="3" controls-position="right" />
          </el-form-item>
          <el-form-item label="整编流量">
            <span class="gb-mono page__compiled-flow">{{ compiledFlow.toFixed(2) }} m³/s</span>
            <span class="gb-hint">按采用参数在测次水位 {{ currentSection.stageM.toFixed(2) }} m 处推求</span>
          </el-form-item>
          <el-form-item label="整编人">
            <el-input v-model="form.operator" maxlength="32" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.note" type="textarea" :rows="2" placeholder="采用说明或调整原因" maxlength="120" />
          </el-form-item>
        </el-form>

        <div v-if="compileStore.receiptsOfSection(currentSection.id).length > 0" class="page__receipt-history">
          <h4>回执历史</h4>
          <el-table :data="compileStore.receiptsOfSection(currentSection.id)" size="small" border>
            <el-table-column label="时间" width="170">
              <template #default="{ row }"><span class="gb-mono">{{ new Date(row.receivedAt).toLocaleString('zh-CN') }}</span></template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="receiptType(row.status)" effect="light">{{ receiptLabel(row.status) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="采用参数" min-width="200">
              <template #default="{ row }">
                <span v-if="row.status === 'accepted'" class="gb-mono">
                  Q={{ row.a }}·(H-{{ row.h0 }})^{{ row.b }} · {{ row.compiledFlowM3s.toFixed(1) }} m³/s
                </span>
                <span v-else class="gb-hint">{{ row.note }}</span>
              </template>
            </el-table-column>
            <el-table-column label="整编人" width="120">
              <template #default="{ row }">{{ row.operator }}</template>
            </el-table-column>
          </el-table>
        </div>
      </template>

      <template #footer>
        <el-button @click="receiptDialogVisible = false">关闭</el-button>
        <el-button type="warning" :icon="RefreshLeft" :loading="submitting" @click="handleReject">驳回</el-button>
        <el-button type="info" :icon="RefreshLeft" :loading="submitting" @click="handleWithdraw">撤回</el-button>
        <el-button type="primary" :icon="Check" :loading="submitting" @click="handleAccept">出具受理回执</el-button>
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

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__tabs {
  background: #ffffff;
  border: 1px solid #d8e4ec;
  border-radius: 10px;
  padding: 0 16px;
}

.page__tab-badge {
  margin-left: 4px;
}

.page__legacy-alert {
  margin-bottom: 12px;
}

.page__receipt-meta {
  margin-bottom: 12px;
}

.page__receipt-alert {
  margin-bottom: 12px;
}

.page__receipt-form {
  margin-top: 8px;
}

.page__line-no {
  width: 120px;
}

.page__compiled-flow {
  font-size: 16px;
  font-weight: 700;
  color: #0f4c75;
  margin-right: 8px;
}

.page__warn {
  color: #d68910;
}

.page__receipt-history {
  margin-top: 16px;
}

.page__receipt-history h4 {
  margin: 0 0 8px;
  font-size: 14px;
  color: #0f4c75;
}
</style>
