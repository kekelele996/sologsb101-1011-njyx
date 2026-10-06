/**
 * useRatingFit：水位流量点据拟合、残差与定线状态管理。
 * 被关系点据页与导出页消费；点据数据来自 ratingStore（IndexedDB 实时订阅）。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRatingStore } from '@/stores/ratingStore'
import type { Compare } from '@/types/compare'
import {
  curveFlow,
  fitPowerCurve,
  type Rating,
  type RatingFitResult
} from '@/types/rating'

/** 曲线采样点（用于关系曲线绘制） */
export interface CurveSample {
  stageM: number
  flowM3s: number
}

/** 带残差的点据行 */
export interface RatingPointRow {
  rating: Rating
  stationName: string
  /** 曲线流量 */
  curveFlowM3s: number
  /** 相对残差（%）：(实测 - 曲线) / 实测 × 100 */
  residualPct: number
  fit: RatingFitResult
}

export interface UseRatingFitResult {
  ratings: Ref<Rating[]>
  compares: Ref<Compare[]>
  /** 参与定线的定线号列表 */
  lineNos: ComputedRef<string[]>
  /** 当前选中定线号 */
  activeLineNo: Ref<string>
  /** 当前定线的拟合结果 */
  fit: ComputedRef<RatingFitResult>
  /** 全部定线的拟合结果 */
  allFits: ComputedRef<RatingFitResult[]>
  /** 当前定线的点据（含残差） */
  pointRows: ComputedRef<RatingPointRow[]>
  /** 当前定线的曲线采样点，用于绘制曲线 */
  curveSamples: ComputedRef<CurveSample[]>
  /** 超限点据清单 */
  overLimitRows: ComputedRef<RatingPointRow[]>
  /** 超限点据对应的比测记录 */
  overLimitCompares: ComputedRef<Compare[]>
  setActiveLine: (lineNo: string) => void
  /** 按当前点据重算定线参数并回写 store */
  refit: () => RatingFitResult
}

/**
 * 组合式函数：按定线号分组拟合幂函数 Q = a×(H-H0)^b，并给出逐点残差。
 */
export function useRatingFit(initialLineNo = 'A'): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const { ratings, compares } = storeToRefs(ratingStore)
  const activeLineNo = ref<string>(initialLineNo)

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    if (set.size === 0) set.add(initialLineNo)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string => {
    const station = ratingStore.stations.find((item) => item.id === stationId)
    return station ? station.name : '未知测站'
  }

  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => {
      const points = ratings.value
        .filter((rating) => rating.lineNo === lineNo)
        .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s }))
      return fitPowerCurve(points, lineNo)
    })
  )

  const fit = computed<RatingFitResult>(() => {
    const found = allFits.value.find((item) => item.lineNo === activeLineNo.value)
    if (found) return found
    return fitPowerCurve([], activeLineNo.value)
  })

  const pointRows = computed<RatingPointRow[]>(() => {
    const current = fit.value
    return ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const predicted = current.valid ? curveFlow(current, rating.stageM) : 0
        const residualPct =
          current.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return {
          rating,
          stationName: stationNameOf(rating.stationId),
          curveFlowM3s: predicted,
          residualPct,
          fit: current
        }
      })
  })

  const curveSamples = computed<CurveSample[]>(() => {
    const current = fit.value
    const rows = pointRows.value
    if (!current.valid || rows.length === 0) return []
    const stages = rows.map((row) => row.rating.stageM)
    const min = Math.min(...stages)
    const max = Math.max(...stages)
    const step = (max - min) / 12 || 0.1
    return Array.from({ length: 13 }, (_, index) => {
      const stageM = Number((min + step * index).toFixed(2))
      return { stageM, flowM3s: curveFlow(current, stageM) }
    })
  })

  const overLimitRows = computed<RatingPointRow[]>(() => {
    const limit = ratingStore.deviationLimitPct
    return allFits.value.flatMap((item) =>
      ratings.value
        .filter((rating) => rating.lineNo === item.lineNo)
        .map((rating) => {
          const predicted = item.valid ? curveFlow(item, rating.stageM) : 0
          const residualPct =
            item.valid && rating.flowM3s > 0
              ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
              : 0
          return {
            rating,
            stationName: stationNameOf(rating.stationId),
            curveFlowM3s: predicted,
            residualPct,
            fit: item
          }
        })
        .filter((row) => Math.abs(row.residualPct) > limit)
    )
  })

  const overLimitCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.verdict === '超限')
  )

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function refit(): RatingFitResult {
    const points = ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s }))
    const result = fitPowerCurve(points, activeLineNo.value)
    ratingStore.setFit(result)
    return result
  }

  return {
    ratings,
    compares,
    lineNos,
    activeLineNo,
    fit,
    allFits,
    pointRows,
    curveSamples,
    overLimitRows,
    overLimitCompares,
    setActiveLine,
    refit
  }
}
