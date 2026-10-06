<script setup lang="ts">
/**
 * 模块 2：/stations/:id/sections 断面测次列表与测法标记
 * 新增测次后回显当前水位；深链访问时若测站不存在给出友好空态。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Promotion, Right, Timer } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import CompileStatusTag from '@/components/common/CompileStatusTag.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useCompileStore } from '@/stores/compileStore'
import { MEASURE_METHODS, type MeasureMethod, type Section } from '@/types/section'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const compileStore = useCompileStore()

const stationId = computed(() => String(route.params.id ?? ''))
const station = computed(() => stationStore.stationById(stationId.value))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  measureNo: '',
  startDistanceM: 0,
  stageM: 0,
  method: '流速仪' as MeasureMethod,
  measuredAt: new Date().toISOString().slice(0, 16)
})

const sectionRows = computed(() => {
  const list = sectionStore.sectionsOfStation(stationId.value)
  return list.filter((section) => {
    const keyword = sectionStore.filter.keyword.trim()
    if (keyword.length > 0 && !`${section.measureNo}${section.method}`.includes(keyword)) return false
    if (sectionStore.filter.methods.length > 0 && !sectionStore.filter.methods.includes(section.method)) return false
    if (sectionStore.filter.minStageM !== null && section.stageM < sectionStore.filter.minStageM) return false
    return true
  })
})

/** 历史遗留只读测次：升级时认不出归属的，单列只读保留 */
const legacySections = computed(() =>
  sectionStore
    .sectionsOfStation(stationId.value)
    .filter((section) => section.legacyReadonly)
)

const filterModel = computed<FilterModel>(() => ({
  keyword: sectionStore.filter.keyword,
  methods: sectionStore.filter.methods,
  minStageM: sectionStore.filter.minStageM
}))

const stats = computed(() => {
  const list = sectionStore.sectionsOfStation(stationId.value)
  const stages = list.map((section) => section.stageM)
  const verticalCount = list.reduce(
    (sum, section) => sum + (sectionStore.sectionVerticalCounts[section.id] ?? 0),
    0
  )
  return {
    count: list.length,
    maxStageM: stages.length ? Math.max(...stages) : null,
    minStageM: stages.length ? Math.min(...stages) : null,
    latest: list.reduce<Section | null>((acc, section) => {
      if (!acc) return section
      return Date.parse(section.measuredAt) > Date.parse(acc.measuredAt) ? section : acc
    }, null),
    verticalCount,
    currentStageM: list.length ? list[0].stageM : null
  }
})

function openCreate(): void {
  editingId.value = null
  form.measureNo = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(
    stats.value.count + 1
  ).padStart(3, '0')}`
  form.startDistanceM = stats.value.latest?.startDistanceM ?? 0
  form.stageM = stats.value.latest?.stageM ?? 0
  form.method = '流速仪'
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(section: Section): void {
  editingId.value = section.id
  form.measureNo = section.measureNo
  form.startDistanceM = section.startDistanceM
  form.stageM = section.stageM
  form.method = section.method
  form.measuredAt = section.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.measureNo.trim()) {
    ElMessage.warning('请填写测次号')
    return
  }
  if (!Number.isFinite(form.stageM) || form.stageM <= -50 || form.stageM > 200) {
    ElMessage.warning('水位应在 -50 ~ 200 m 之间')
    return
  }
  if (!Number.isFinite(form.startDistanceM) || form.startDistanceM < 0) {
    ElMessage.warning('起点距应为非负数字（m）')
    return
  }
  if (!form.measuredAt) {
    ElMessage.warning('请选择测流时间')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: stationId.value,
      measureNo: form.measureNo.trim(),
      startDistanceM: form.startDistanceM,
      stageM: form.stageM,
      method: form.method,
      measuredAt: new Date(form.measuredAt).toISOString(),
      compileStatus: 'pending' as const,
      legacyReadonly: false
    }
    if (editingId.value) {
      await sectionStore.updateSection(editingId.value, payload)
      ElMessage.success('测次已更新')
    } else {
      const created = await sectionStore.createSection(payload)
      sectionStore.selectSection(created.id)
      ElMessage.success(`测次已新增，当前水位 ${created.stageM.toFixed(2)} m`)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function removeSection(section: Section): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除测次「${section.measureNo}」将同时删除其垂线、流速测点与相关计算，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await sectionStore.removeSection(section.id)
  ElMessage.success('测次及其垂线测点已删除')
}

/** 测站报整编：测流成果报去流域整编中心 */
async function submitForCompile(section: Section): Promise<void> {
  if (section.legacyReadonly) return
  await compileStore.submitForCompile(section.id)
  ElMessage.success(`测次 ${section.measureNo} 已报整编，等待整编端出具回执`)
}

function gotoVerticals(section: Section): void {
  sectionStore.selectSection(section.id)
  void router.push(`/sections/${section.id}/verticals`)
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(sectionStore.filter.keyword.trim() ? { kw: sectionStore.filter.keyword.trim() } : {}),
      ...(sectionStore.filter.methods.length ? { methods: sectionStore.filter.methods.join(',') } : {}),
      ...(sectionStore.filter.minStageM !== null ? { minStage: String(sectionStore.filter.minStageM) } : {})
    }
  })
}

function handleReset(): void {
  sectionStore.resetFilter()
  void router.replace({ query: {} })
}

function reseedIfEmpty(): void {
  if (stationStore.stations.length === 0) void initDatabase()
}

onMounted(() => {
  reseedIfEmpty()
  compileStore.start()
  const query = route.query
  sectionStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    methods: typeof query.methods === 'string' ? (query.methods.split(',') as MeasureMethod[]) : [],
    minStageM: typeof query.minStage === 'string' ? Number(query.minStage) : null
  })
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!stationStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!station"
      entity-label="测站"
      :missing-id="stationId"
      fallback-path="/stations"
      fallback-text="返回测站台账"
      :candidates="
        stationStore.stations.slice(0, 3).map((item) => ({
          id: item.id,
          label: `${item.name} 的测次`,
          path: `/stations/${item.id}/sections`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/stations' }">测站台账</el-breadcrumb-item>
            <el-breadcrumb-item>{{ station.name }}</el-breadcrumb-item>
            <el-breadcrumb-item>断面测次</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            {{ station.name }} · 断面测次
            <el-tag size="small" effect="plain" class="page__tag">{{ station.sectionCode }}</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ station.river }}</el-tag>
          </h2>
          <p class="gb-hint">
            集水面积 {{ station.catchmentKm2 }} km²。每次测流记录测次号、起点距、水位与测法，随后布设垂线并录流速测点。
          </p>
        </div>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增测次</el-button>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="测次总数" :value="stats.count" suffix="次" icon="Files" />
        <StatBadge
          label="当前水位"
          :value="stats.currentStageM === null ? '—' : stats.currentStageM.toFixed(2)"
          suffix="m"
          tone="info"
          icon="Odometer"
        />
        <StatBadge
          label="水位变幅"
          :value="stats.minStageM === null ? '—' : `${stats.minStageM.toFixed(2)} ~ ${stats.maxStageM?.toFixed(2)}`"
          suffix="m"
          tone="warning"
          icon="TrendCharts"
        />
        <StatBadge label="垂线合计" :value="stats.verticalCount" suffix="条" tone="success" icon="Histogram" />
      </div>

      <FilterBar
        :model-value="filterModel"
        :selects="[
          { key: 'methods', label: '测法', options: MEASURE_METHODS.map((method) => ({ label: method, value: method })) }
        ]"
        :number-ranges="[{ key: 'minStageM', label: '水位不低于', placeholder: '不限', unit: 'm' }]"
        keyword-placeholder="搜索测次号 / 测法"
        @change="handleFilterChange"
        @reset="handleReset"
      >
        <template #extra>
          <el-tag v-if="stats.latest" type="success" effect="plain">
            最新测次 {{ stats.latest.measureNo }} · 水位 {{ stats.latest.stageM.toFixed(2) }} m
          </el-tag>
        </template>
      </FilterBar>

      <EmptyPanel
        v-if="sectionRows.length === 0"
        :title="sectionStore.sectionsOfStation(stationId).length === 0 ? '该测站还没有测次' : '没有符合条件的测次'"
        description="新增一次流量测验后，即可布设垂线、录入测深与流速测点。"
        action-text="新增测次"
        secondary-text="重置筛选"
        @action="openCreate"
        @secondary="handleReset"
      />

      <el-table v-else :data="sectionRows" border stripe class="gb-table-compact">
        <el-table-column prop="measureNo" label="测次号" min-width="150" />
        <el-table-column label="测法" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.method === 'ADCP' ? 'success' : row.method === '浮标' ? 'warning' : 'primary'" effect="plain">
              {{ row.method }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="起点距 (m)" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.startDistanceM.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="垂线条数" width="110" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoVerticals(row)">
              {{ sectionStore.sectionVerticalCounts[row.id] ?? 0 }} 条
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="整编状态" width="110">
          <template #default="{ row }">
            <CompileStatusTag v-if="!row.legacyReadonly" :status="row.compileStatus" />
            <el-tag v-else size="small" type="info" effect="plain">只读</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="测流时间" min-width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.measuredAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" @click="gotoVerticals(row)">垂线</el-button>
            <el-button size="small" :icon="Edit" :disabled="row.legacyReadonly" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" :disabled="row.legacyReadonly" @click="removeSection(row)">删除</el-button>
            <el-button
              v-if="!row.legacyReadonly && row.compileStatus === 'pending'"
              size="small"
              type="success"
              plain
              :icon="Promotion"
              @click="submitForCompile(row)"
            >报整编</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无测次" description="点击右上角「新增测次」开始录入。" compact />
        </template>
      </el-table>

      <!-- 历史遗留只读测次：升级时认不出归属的，单列只读保留 -->
      <el-card v-if="legacySections.length > 0" shadow="never" class="page__legacy-card">
        <div class="gb-panel-title">
          <h3>历史遗留测次（只读保留）</h3>
          <span class="gb-hint">升级时认不出归属的测次，单列只读保留，不可编辑或报整编</span>
        </div>
        <el-table :data="legacySections" border size="small" class="gb-table-compact">
          <el-table-column prop="measureNo" label="测次号" min-width="150" />
          <el-table-column label="水位 (m)" width="110" align="right">
            <template #default="{ row }"><span class="gb-mono">{{ row.stageM.toFixed(2) }}</span></template>
          </el-table-column>
          <el-table-column label="测法" width="110">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.method }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{ row }"><el-tag size="small" type="info" effect="plain">只读</el-tag></template>
          </el-table-column>
        </el-table>
      </el-card>

      <p class="gb-hint">
        <el-icon><Timer /></el-icon>
        提示：测次的水位将参与水位流量关系点据定线；同一测次下的垂线按起点距升序参与部分面积法流量计算。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑测次' : '新增断面测次'" width="560px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="测次号" required>
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="测法" required>
          <el-radio-group v-model="form.method">
            <el-radio-button v-for="method in MEASURE_METHODS" :key="method" :value="method">{{ method }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="起点距" required>
          <el-input-number v-model="form.startDistanceM" :min="0" :max="2000" :step="0.5" :precision="1" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="测流时间" required>
          <el-date-picker v-model="form.measuredAt" type="datetime" placeholder="选择测流时间" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增并布设垂线' }}
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

.page__tag {
  font-weight: 400;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}
</style>
