<script setup lang="ts">
/**
 * <CompileStatusTag> 测次整编状态徽标。
 * 待整编（灰）/ 已报整编（黄）/ 已完成（绿），被断面列表与整编中心消费。
 */
import { computed } from 'vue'
import { CircleCheckFilled, Clock, Promotion } from '@element-plus/icons-vue'
import {
  COMPILE_STATUS_COLORS,
  COMPILE_STATUS_LABELS,
  type CompileStatus
} from '@/types/receipt'

const props = withDefaults(
  defineProps<{
    status: CompileStatus
    size?: 'default' | 'small' | 'large'
    showIcon?: boolean
  }>(),
  {
    size: 'default',
    showIcon: true
  }
)

const iconComponent = computed(() => {
  if (props.status === 'accepted') return CircleCheckFilled
  if (props.status === 'submitted') return Promotion
  return Clock
})

const label = computed(() => COMPILE_STATUS_LABELS[props.status])
const color = computed(() => COMPILE_STATUS_COLORS[props.status])
</script>

<template>
  <el-tag
    :size="size"
    :type="color"
    effect="light"
    round
    class="compile-status-tag"
  >
    <el-icon v-if="showIcon" class="compile-status-tag__icon"><component :is="iconComponent" /></el-icon>
    {{ label }}
  </el-tag>
</template>

<style scoped>
.compile-status-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.compile-status-tag__icon {
  font-size: 13px;
}
</style>
