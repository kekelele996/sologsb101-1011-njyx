/**
 * 流量计算工具：垂线加权平均流速、部分面积法与断面流量计算。
 * 页面、store 与数据库播种共用同一套算法，保证展示值与存储值一致。
 */

/** 默认计算权重：一点法 1.0、两点法 0.5/0.5、三点法 1/3、五点法 0.2 */
export const DEFAULT_WEIGHTS: number[] = [1, 0.5, 1 / 3, 0.25, 0.2]

/** 保留小数位（避免浮点误差累积） */
export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 加权平均流速：权重缺失时按算术平均 */
export function calcMeanVelocity(rows: Array<{ velocityMs: number; weight?: number }>): number {
  const valid = rows.filter((row) => Number.isFinite(row.velocityMs) && row.velocityMs >= 0)
  if (valid.length === 0) return 0
  const totalWeight = valid.reduce((sum, row) => sum + (row.weight && row.weight > 0 ? row.weight : 0), 0)
  if (totalWeight <= 0) {
    const sum = valid.reduce((acc, row) => acc + row.velocityMs, 0)
    return round(sum / valid.length, 3)
  }
  const weighted = valid.reduce(
    (sum, row) => sum + row.velocityMs * (row.weight && row.weight > 0 ? row.weight : 0),
    0
  )
  return round(weighted / totalWeight, 3)
}

/** 按相对水深自动分配权重：水面/河底 0.1、0.2/0.8 各 0.3、0.6 计 0.3，归一化后返回 */
export function autoWeights(count: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [1]
  return Array.from({ length: count }, () => round(1 / count, 4))
}

/** 断面垂线输入（按起点距升序） */
export interface VerticalSlice {
  id: string
  no: number
  startDistanceM: number
  depthM: number
  meanVelocityMs: number
}

/** 部分面积法计算成果 */
export interface DischargeResult {
  /** 断面流量（m³/s） */
  flowM3s: number
  /** 断面面积（m²） */
  areaM2: number
  /** 断面平均流速（m/s） */
  meanVelocityMs: number
  /** 最大水深（m） */
  maxDepthM: number
  /** 水面宽（m） */
  widthM: number
  /** 逐垂线的部分面积与部分流量 */
  slices: Array<{ id: string; no: number; partialAreaM2: number; partialFlow: number }>
}

/**
 * 部分面积法（mid-section）计算断面流量：
 * 以每条垂线为中心，左右各取半间距合成部分宽度，部分流量 = 部分宽度 × 水深 × 垂线平均流速。
 */
export function calcSectionDischarge(input: VerticalSlice[]): DischargeResult {
  const verticals = [...input]
    .filter((vertical) => Number.isFinite(vertical.startDistanceM) && Number.isFinite(vertical.depthM))
    .sort((a, b) => a.startDistanceM - b.startDistanceM)

  const empty: DischargeResult = {
    flowM3s: 0,
    areaM2: 0,
    meanVelocityMs: 0,
    maxDepthM: 0,
    widthM: 0,
    slices: []
  }
  if (verticals.length === 0) return empty
  if (verticals.length === 1) {
    const only = verticals[0]
    const partialAreaM2 = round(only.depthM * 1, 3)
    const partialFlow = round(partialAreaM2 * only.meanVelocityMs, 3)
    return {
      flowM3s: partialFlow,
      areaM2: partialAreaM2,
      meanVelocityMs: round(only.meanVelocityMs, 3),
      maxDepthM: round(only.depthM, 2),
      widthM: 0,
      slices: [{ id: only.id, no: only.no, partialAreaM2, partialFlow }]
    }
  }

  const slices = verticals.map((vertical, index) => {
    const previous = verticals[index - 1]
    const next = verticals[index + 1]
    const leftSpan = previous ? (vertical.startDistanceM - previous.startDistanceM) / 2 : 0
    const rightSpan = next ? (next.startDistanceM - vertical.startDistanceM) / 2 : 0
    const span = index === 0 || index === verticals.length - 1 ? leftSpan + rightSpan : leftSpan + rightSpan
    const partialAreaM2 = round(vertical.depthM * span, 3)
    const partialFlow = round(partialAreaM2 * vertical.meanVelocityMs, 3)
    return { id: vertical.id, no: vertical.no, partialAreaM2, partialFlow }
  })

  const areaM2 = round(
    slices.reduce((sum, slice) => sum + slice.partialAreaM2, 0),
    2
  )
  const flowM3s = round(
    slices.reduce((sum, slice) => sum + slice.partialFlow, 0),
    3
  )
  const widthM = round(
    verticals[verticals.length - 1].startDistanceM - verticals[0].startDistanceM,
    2
  )
  const maxDepthM = round(
    Math.max(...verticals.map((vertical) => vertical.depthM)),
    2
  )
  return {
    flowM3s,
    areaM2,
    meanVelocityMs: areaM2 > 0 ? round(flowM3s / areaM2, 3) : 0,
    maxDepthM,
    widthM,
    slices
  }
}

/** 由垂线水深与平均流速估算单宽流量（m²/s），用于断面流速分布展示 */
export function unitDischarge(depthM: number, meanVelocityMs: number): number {
  return round(depthM * meanVelocityMs, 3)
}

/** 流速仪测点历时换算：转数 / 历时 → 流速（简化直线公式，供测点录入校验提示） */
export function velocityFromRevolutions(revolutions: number, durationS: number, k = 0.25, c = 0.01): number {
  if (!Number.isFinite(revolutions) || !Number.isFinite(durationS) || durationS <= 0) return 0
  return round(k * (revolutions / durationS) + c, 3)
}

/** 水位流量关系幂函数值：Q = a × (H - H0)^b */
export function powerFlow(a: number, b: number, h0: number, stageM: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return round(a * Math.pow(Math.max(stageM - h0, 1e-6), b), 2)
}
