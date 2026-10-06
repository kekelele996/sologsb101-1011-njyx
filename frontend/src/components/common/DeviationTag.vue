<script setup lang="ts">
/**
 * <DeviationTag> 按偏差区间渲染配色与提示文案。
 * 被关系点据页（/ratings）与导出页（/export）消费。
 */
import { computed } from 'vue'
import { CircleCheckFilled, WarningFilled } from '@element-plus/icons-vue'
import { DEVIATION_LIMIT_PCT } from '@/types/compare'

const props = withDefaults(
  defineProps<{
    /** 偏差百分比，正负均可 */
    deviationPct: number
    /** 判定结论；不传时按限值自动判定 */
    verdict?: '合格' | '超限'
    /** 允许偏差限值（%），默认取常量 8% */
    limit?: number
    /** 是否显示偏差数值 */
    showValue?: boolean
    size?: 'default' | 'small' | 'large'
  }>(),
  {
    verdict: undefined,
    limit: DEVIATION_LIMIT_PCT,
    showValue: true,
    size: 'default'
  }
)

/** 偏差分档：优良 / 合格 / 超限 / 严重超限 */
const tone = computed(() => {
  const abs = Math.abs(props.deviationPct)
  if (abs <= props.limit * 0.5) return 'excellent'
  if (abs <= props.limit) return 'ok'
  if (abs <= props.limit * 2) return 'over'
  return 'severe'
})

const TONE_STYLE: Record<string, { color: string; bg: string; border: string; label: string }> = {
  excellent: { color: '#1e8449', bg: '#eaf6ee', border: '#1e8449', label: '偏差优良' },
  ok: { color: '#3f7d20', bg: '#f0f7e8', border: '#7ab648', label: '偏差合格' },
  over: { color: '#b9770e', bg: '#fdf3e3', border: '#d68910', label: '偏差超限' },
  severe: { color: '#c0392b', bg: '#fdecea', border: '#c0392b', label: '偏差严重超限' }
}

const style = computed(() => TONE_STYLE[tone.value])
const text = computed(() => {
  const value = `${props.deviationPct > 0 ? '+' : ''}${props.deviationPct.toFixed(2)}%`
  return props.showValue ? value : style.value.label
})
const iconComponent = computed(() => (tone.value === 'excellent' || tone.value === 'ok' ? CircleCheckFilled : WarningFilled))
const tip = computed(() => {
  if (tone.value === 'over' || tone.value === 'severe') {
    return `${style.value.label}：曲线流量与实测流量相差 ${Math.abs(props.deviationPct).toFixed(2)}%，超过限值 ${props.limit}%，请复核定线`
  }
  return `${style.value.label}：偏差 ${Math.abs(props.deviationPct).toFixed(2)}%，在限值 ${props.limit}% 以内`
})
</script>

<template>
  <el-tooltip :content="tip" placement="top">
    <span
      class="deviation-tag"
      :class="[`is-${size}`, `is-${tone}`]"
      :style="{ color: style.color, backgroundColor: style.bg, borderColor: style.border }"
    >
      <el-icon class="deviation-tag__icon"><component :is="iconComponent" /></el-icon>
      <span class="deviation-tag__value gb-mono">{{ text }}</span>
      <span v-if="showValue" class="deviation-tag__label">{{ style.label }}</span>
    </span>
  </el-tooltip>
</template>

<style scoped>
.deviation-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
}

.deviation-tag.is-small {
  padding: 0 8px;
  font-size: 12px;
  line-height: 18px;
}

.deviation-tag.is-large {
  padding: 4px 14px;
  font-size: 15px;
  line-height: 24px;
}

.deviation-tag__icon {
  font-size: 13px;
}

.deviation-tag__label {
  font-weight: 400;
  opacity: 0.85;
}
</style>
