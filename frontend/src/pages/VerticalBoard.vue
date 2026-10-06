<script setup lang="ts">
/**
 * 模块 3：/sections/:id/verticals 垂线布设与测深记录
 * 起点距排序校验（重复起点距高亮告警）、按相对水深自动生成测点行、
 * 部分面积法汇总断面流量；深链访问时断面不存在给出友好空态。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, Right, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useArchiveStore } from '@/stores/archiveStore'
import { buildRelativeDepths, type Vertical } from '@/types/vertical'
import { calcMeanVelocity, calcSectionDischarge } from '@/utils/flow'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const archiveStore = useArchiveStore()

const sectionId = computed(() => String(route.params.id ?? ''))
const section = computed(() => sectionStore.sectionById(sectionId.value))
const station = computed(() => (section.value ? stationStore.stationById(section.value.stationId) : null))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  no: 1,
  startDistanceM: 0,
  depthM: 1,
  pointCount: 2,
  bedNote: ''
})

const verticals = computed(() => sectionStore.verticalsOfSection(sectionId.value))
const conflicts = computed(() => (section.value ? sectionStore.findDistanceConflicts(sectionId.value) : []))

/** 该测次的整编报送状态：回执到达后再改垂线，原回执会作废 */
const archiveRow = computed(() => (section.value ? archiveStore.submissionBySection(section.value.id) : null))

/** 每条垂线的平均流速（按测点权重加权）与单宽流量 */
const verticalRows = computed(() =>
  verticals.value.map((vertical) => {
    const points = sectionStore.pointsOfVertical(vertical.id)
    const meanVelocityMs = calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
    return { vertical, points, meanVelocityMs }
  })
)

/** 断面流量成果：部分面积法 */
const discharge = computed(() =>
  calcSectionDischarge(
    verticalRows.value.map((row) => ({
      id: row.vertical.id,
      no: row.vertical.no,
      startDistanceM: row.vertical.startDistanceM,
      depthM: row.vertical.depthM,
      meanVelocityMs: row.meanVelocityMs
    }))
  )
)

const stats = computed(() => ({
  verticalCount: verticals.value.length,
  pointCount: verticalRows.value.reduce((sum, row) => sum + row.points.length, 0),
  maxDepthM: verticals.value.length ? Math.max(...verticals.value.map((item) => item.depthM)) : 0,
  widthM: discharge.value.widthM
}))

function nextNo(): number {
  const numbers = verticals.value.map((vertical) => vertical.no)
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1
}

function openCreate(): void {
  editingId.value = null
  const last = verticals.value[verticals.value.length - 1]
  form.no = nextNo()
  form.startDistanceM = last ? Number((last.startDistanceM + 6).toFixed(1)) : 0
  form.depthM = last ? last.depthM : 1
  form.pointCount = 2
  form.bedNote = ''
  dialogVisible.value = true
}

function openEdit(vertical: Vertical): void {
  editingId.value = vertical.id
  form.no = vertical.no
  form.startDistanceM = vertical.startDistanceM
  form.depthM = vertical.depthM
  form.pointCount = vertical.pointCount
  form.bedNote = vertical.bedNote
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!Number.isFinite(form.startDistanceM) || form.startDistanceM < 0) {
    ElMessage.warning('起点距应为非负数字（m）')
    return
  }
  if (!Number.isFinite(form.depthM) || form.depthM <= 0) {
    ElMessage.warning('水深应大于 0（m）')
    return
  }
  if (!Number.isInteger(form.pointCount) || form.pointCount < 1 || form.pointCount > 5) {
    ElMessage.warning('测点数应在 1 ~ 5 之间')
    return
  }
  submitting.value = true
  try {
    if (editingId.value) {
      await sectionStore.updateVertical(editingId.value, {
        no: form.no,
        startDistanceM: form.startDistanceM,
        depthM: form.depthM,
        bedNote: form.bedNote
      })
      await sectionStore.regeneratePoints(editingId.value, form.pointCount)
      ElMessage.success('垂线已更新，测点行已按相对水深重排')
    } else {
      const created = await sectionStore.createVertical(sectionId.value, {
        no: form.no,
        startDistanceM: form.startDistanceM,
        depthM: form.depthM,
        bedNote: form.bedNote,
        pointCount: form.pointCount
      })
      sectionStore.selectVertical(created.id)
      ElMessage.success(`垂线 ${created.no} 已新增，自动生成 ${created.pointCount} 个测点行`)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeVertical(vertical: Vertical): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除垂线 ${vertical.no} 将同时删除其 ${vertical.pointCount} 个流速测点，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await sectionStore.removeVertical(vertical.id)
  ElMessage.success('垂线及其测点已删除')
}

async function regenerate(vertical: Vertical): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `按当前测点数（${vertical.pointCount}）重新生成测点行？已录入的流速值会按相对水深尽量保留。`,
      '重新生成测点行',
      { type: 'info', confirmButtonText: '重新生成', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const depths = buildRelativeDepths(vertical.pointCount)
  const count = await sectionStore.regeneratePoints(vertical.id, depths.length)
  ElMessage.success(`已重新生成 ${count} 个测点行`)
}

function gotoPoints(vertical: Vertical): void {
  sectionStore.selectVertical(vertical.id)
  void router.push(`/verticals/${vertical.id}/points`)
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  archiveStore.start()
  sectionStore.selectSection(sectionId.value)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!sectionStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!section"
      entity-label="断面测次"
      :missing-id="sectionId"
      fallback-path="/stations"
      fallback-text="返回测站台账"
      :candidates="
        sectionStore.sections.slice(0, 3).map((item) => ({
          id: item.id,
          label: `测次 ${item.measureNo} 的垂线`,
          path: `/sections/${item.id}/verticals`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/stations' }">测站台账</el-breadcrumb-item>
            <el-breadcrumb-item :to="{ path: `/stations/${section.stationId}/sections` }">
              {{ station?.name ?? '测站' }} 断面测次
            </el-breadcrumb-item>
            <el-breadcrumb-item>垂线布设</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            测次 {{ section.measureNo }} · 垂线布设与测深
            <el-tag size="small" effect="plain">{{ section.method }}</el-tag>
            <el-tag size="small" type="info" effect="plain">水位 {{ section.stageM.toFixed(2) }} m</el-tag>
          </h2>
          <p class="gb-hint">
            录入起点距与水深，测点数决定按相对水深自动生成的测点行（1/2/3/5 点法有预设分布）。垂线按起点距升序参与流量计算。
          </p>
        </div>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增垂线</el-button>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="垂线条数" :value="stats.verticalCount" suffix="条" icon="Histogram" />
        <StatBadge label="测点合计" :value="stats.pointCount" suffix="点" tone="info" icon="DataLine" />
        <StatBadge label="最大水深" :value="stats.maxDepthM.toFixed(2)" suffix="m" tone="warning" icon="Odometer" />
        <StatBadge label="断面流量" :value="discharge.flowM3s.toFixed(2)" suffix="m³/s" tone="success" icon="TrendCharts" />
      </div>

      <el-alert
        v-if="conflicts.length > 0"
        type="warning"
        show-icon
        :closable="false"
        :title="`起点距排序校验未通过：垂线 ${conflicts.join('、')} 的起点距与其他垂线重复，请调整后再参与流量计算`"
      />

      <el-alert
        v-if="archiveRow?.status === '完成'"
        type="info"
        show-icon
        :closable="false"
        title="本测次已有整编回执、整编已完成；现在改动垂线布设会让原回执作废，测次退回待整编，需要重新报送并按新回执走。"
      />
      <el-alert
        v-else-if="archiveRow?.receiptVoided"
        type="warning"
        show-icon
        :closable="false"
        :title="`原整编回执已作废（${archiveRow.voidReason || '测站改动了垂线 / 流速测点'}），本测次已退回待整编，重报后照新回执走。`"
      />

      <EmptyPanel
        v-if="verticalRows.length === 0"
        title="该测次还没有垂线"
        description="新增第一条垂线并录入起点距与水深，系统会按测点数自动生成测点行。"
        action-text="新增垂线"
        @action="openCreate"
      />

      <el-table v-else :data="verticalRows" border stripe class="gb-table-compact">
        <el-table-column label="垂线号" width="90" align="center">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.vertical.no }}</span>
            <el-icon v-if="conflicts.includes(row.vertical.no)" class="page__warn"><Warning /></el-icon>
          </template>
        </el-table-column>
        <el-table-column label="起点距 (m)" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.vertical.startDistanceM.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="水深 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.vertical.depthM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="测点数" width="100" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoPoints(row.vertical)">
              {{ row.points.length }} 点
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="平均流速 (m/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.meanVelocityMs.toFixed(3) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="单宽流量 (m²/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ (row.vertical.depthM * row.meanVelocityMs).toFixed(3) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="vertical.bedNote" label="河床质 / 备注" min-width="170" show-overflow-tooltip />
        <el-table-column label="操作" width="290" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" @click="gotoPoints(row.vertical)">测点</el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row.vertical)">编辑</el-button>
            <el-button size="small" :icon="Refresh" @click="regenerate(row.vertical)">重排</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeVertical(row.vertical)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-if="verticalRows.length > 0" class="gb-panel">
        <div class="gb-panel-title">
          <h3>部分面积法断面流量成果</h3>
          <span class="gb-hint">水面宽 {{ discharge.widthM }} m · 断面面积 {{ discharge.areaM2 }} m² · 平均流速 {{ discharge.meanVelocityMs }} m/s</span>
        </div>
        <el-table :data="discharge.slices" border size="small" class="gb-table-compact">
          <el-table-column prop="no" label="垂线号" width="90" align="center" />
          <el-table-column label="部分面积 (m²)" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.partialAreaM2.toFixed(3) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="部分流量 (m³/s)" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.partialFlow.toFixed(3) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="占断面流量" align="right">
            <template #default="{ row }">
              <span class="gb-mono">
                {{ discharge.flowM3s > 0 ? ((row.partialFlow / discharge.flowM3s) * 100).toFixed(1) : '0.0' }}%
              </span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑垂线' : '新增垂线'" width="540px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="垂线号" required>
          <el-input-number v-model="form.no" :min="1" :max="99" controls-position="right" />
        </el-form-item>
        <el-form-item label="起点距" required>
          <el-input-number v-model="form.startDistanceM" :min="0" :max="3000" :step="0.5" :precision="1" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="水深" required>
          <el-input-number v-model="form.depthM" :min="0.05" :max="80" :step="0.1" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="测点数" required>
          <el-radio-group v-model="form.pointCount">
            <el-radio-button v-for="count in [1, 2, 3, 5]" :key="count" :value="count">{{ count }} 点法</el-radio-button>
          </el-radio-group>
          <p class="gb-hint">
            预设相对水深：{{ buildRelativeDepths(form.pointCount).join(' / ') }}
          </p>
        </el-form-item>
        <el-form-item label="河床质 / 备注">
          <el-input v-model="form.bedNote" placeholder="如：主流，砂卵石" maxlength="60" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增并生成测点' }}
        </el-button>
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
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0f4c75;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__warn {
  margin-left: 4px;
  color: #d68910;
  vertical-align: middle;
}
</style>
