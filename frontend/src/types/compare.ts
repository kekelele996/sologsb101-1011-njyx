import type { Rating } from './rating'

/** 比测判定结论 */
export type CompareVerdict = '合格' | '超限'

/** 比测偏差允许限值（%）：超过则判定超限并挂红 */
export const DEVIATION_LIMIT_PCT = 8

/** 比测记录：实测流量与曲线流量的偏差分析 */
export interface Compare {
  id: string
  /** 被比测的关系点据 */
  ratingId: string
  /** 实测流量（m³/s） */
  measuredFlow: number
  /** 曲线流量（m³/s） */
  curveFlow: number
  /** 偏差（%）：(曲线 - 实测) / 实测 × 100 */
  deviationPct: number
  /** 合格 / 超限 */
  verdict: CompareVerdict
  /** 比测人 */
  operator: string
  /** 比测日期 */
  comparedAt: string
  createdAt: number
  updatedAt: number
}

/** 按偏差计算判定结论 */
export function judgeDeviation(deviationPct: number, limit = DEVIATION_LIMIT_PCT): CompareVerdict {
  return Math.abs(deviationPct) > limit ? '超限' : '合格'
}

/** 计算偏差百分比 */
export function calcDeviationPct(measuredFlow: number, curveFlowValue: number): number {
  if (!Number.isFinite(measuredFlow) || measuredFlow === 0) return 0
  return Number((((curveFlowValue - measuredFlow) / measuredFlow) * 100).toFixed(2))
}

/** 比测行：比测记录 + 所属点据，供导出页与分析清单展示 */
export interface CompareRow {
  compare: Compare
  rating: Rating | null
  stationName: string
  lineNo: string
}
