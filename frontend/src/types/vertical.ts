/** 垂线：断面上的测速垂线，测深后按相对水深生成测点 */
export interface Vertical {
  id: string
  /** 所属断面测次 */
  sectionId: string
  /** 垂线号，如 1、2、3 */
  no: number
  /** 起点距（m） */
  startDistanceM: number
  /** 水深（m） */
  depthM: number
  /** 测点数（由测点行实时回填） */
  pointCount: number
  /** 测深备注（河床质、流向等） */
  bedNote: string
  createdAt: number
  updatedAt: number
}

/** 默认测点相对水深分布：一点法 / 两点法 / 三点法 / 五点法 */
export const RELATIVE_DEPTH_PRESETS: Record<string, number[]> = {
  '1': [0.6],
  '2': [0.2, 0.8],
  '3': [0.2, 0.6, 0.8],
  '5': [0.0, 0.2, 0.6, 0.8, 1.0]
}

/**
 * 按相对水深自动生成测点行：传入测点数返回相对水深数组。
 * 非预设数量时按等分生成（0.2 / 0.6 / 0.8 优先的常用分布回退到等分）。
 */
export function buildRelativeDepths(pointCount: number): number[] {
  const preset = RELATIVE_DEPTH_PRESETS[String(pointCount)]
  if (preset) return [...preset]
  if (pointCount <= 1) return [0.6]
  const step = 1 / (pointCount - 1)
  return Array.from({ length: pointCount }, (_, index) => Number((index * step).toFixed(2)))
}
