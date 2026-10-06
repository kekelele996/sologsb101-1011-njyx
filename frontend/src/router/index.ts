import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

/**
 * 路由表：路径与提示词逐字一致。
 * /stations、/stations/:id/sections、/sections/:id/verticals、/verticals/:id/points、/ratings、/export
 * 全部页面懒加载，构建时自动分包。
 */
const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/stations' },
  {
    path: '/stations',
    name: 'station-list',
    component: () => import('@/pages/StationList.vue'),
    meta: { title: '测站台账', icon: 'Odometer' }
  },
  {
    path: '/stations/:id/sections',
    name: 'section-list',
    component: () => import('@/pages/SectionList.vue'),
    meta: { title: '断面测次', icon: 'Files' }
  },
  {
    path: '/sections/:id/verticals',
    name: 'vertical-board',
    component: () => import('@/pages/VerticalBoard.vue'),
    meta: { title: '垂线布设与测深', icon: 'Histogram' }
  },
  {
    path: '/verticals/:id/points',
    name: 'point-entry',
    component: () => import('@/pages/PointEntry.vue'),
    meta: { title: '流速测点录入', icon: 'DataLine' }
  },
  {
    path: '/ratings',
    name: 'rating-chart',
    component: () => import('@/pages/RatingChart.vue'),
    meta: { title: '水位流量关系点据', icon: 'TrendCharts' }
  },
  {
    path: '/export',
    name: 'export-view',
    component: () => import('@/pages/ExportView.vue'),
    meta: { title: '比测分析与导出', icon: 'PieChart' }
  },
  { path: '/:pathMatch(.*)*', redirect: '/stations' }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '水文站流量测验与绳套曲线台'
  document.title = `${title} · 水文站流量测验与绳套曲线台`
})

export default router
