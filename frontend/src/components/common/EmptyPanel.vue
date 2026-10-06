<script setup lang="ts">
/**
 * <EmptyPanel> 空数据引导与新建入口。
 * 被全部列表页消费；列表为空、筛选无结果、层级路由 id 不存在时统一使用。
 */
import { computed } from 'vue'
import { Box, FolderOpened, MagicStick, Plus } from '@element-plus/icons-vue'

const props = withDefaults(
  defineProps<{
    title?: string
    description?: string
    /** 新建按钮文案，为空则不渲染主按钮 */
    actionText?: string
    /** 次要按钮文案（如「返回测站台账」「重新播种」） */
    secondaryText?: string
    /** 是否展示样例数据按钮 */
    showSeed?: boolean
    compact?: boolean
  }>(),
  {
    title: '暂无数据',
    description: '当前筛选条件下没有记录，可调整条件或新建一条。',
    actionText: '',
    secondaryText: '',
    showSeed: false,
    compact: false
  }
)

const emit = defineEmits<{
  (event: 'action'): void
  (event: 'secondary'): void
  (event: 'seed'): void
}>()

const iconComponent = computed(() => (props.showSeed ? MagicStick : props.actionText ? Box : FolderOpened))
</script>

<template>
  <div class="empty-panel" :class="{ 'is-compact': compact }">
    <el-icon class="empty-panel__icon"><component :is="iconComponent" /></el-icon>
    <h3 class="empty-panel__title">{{ title }}</h3>
    <p class="empty-panel__desc">{{ description }}</p>
    <div class="empty-panel__actions">
      <el-button v-if="actionText" type="primary" :icon="Plus" @click="emit('action')">{{ actionText }}</el-button>
      <el-button v-if="secondaryText" @click="emit('secondary')">{{ secondaryText }}</el-button>
      <el-button v-if="showSeed" type="success" plain :icon="MagicStick" @click="emit('seed')">生成样例数据</el-button>
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.empty-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 44px 24px;
  background: #f7fafc;
  border: 1px dashed #b9cfdd;
  border-radius: 12px;
  text-align: center;
}

.empty-panel.is-compact {
  padding: 24px 16px;
}

.empty-panel__icon {
  font-size: 34px;
  color: #7fa3bb;
}

.empty-panel__title {
  margin: 4px 0 0;
  font-size: 16px;
  font-weight: 600;
  color: #16232e;
}

.empty-panel__desc {
  margin: 0;
  max-width: 520px;
  font-size: 13px;
  line-height: 1.7;
  color: #5b6b78;
}

.empty-panel__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
</style>
