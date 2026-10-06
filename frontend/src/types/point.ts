/** 流速测点：垂线上按相对水深布设的测速点 */
export interface Point {
  id: string
  /** 所属垂线 */
  verticalId: string
  /** 相对水深：0 为水面、1 为河底 */
  relativeDepth: number
  /** 测点流速（m/s） */
  velocityMs: number
  /** 计算权重（垂直流速分布加权系数） */
  weight: number
  /** 测速历时（s） */
  durationS: number
  createdAt: number
  updatedAt: number
}

/** 批量粘贴解析出的一行测点草稿 */
export interface PointDraftRow {
  relativeDepth: number
  velocityMs: number
  durationS: number
}

/**
 * 解析批量粘贴文本：每行「相对水深,流速[,历时]」，逗号 / 空格 / 制表符均可作分隔。
 * 返回可导入的测点草稿与逐行错误说明。
 */
export function parsePointPaste(text: string): { rows: PointDraftRow[]; errors: string[] } {
  const rows: PointDraftRow[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；\s]+/).filter((cell) => cell.length > 0)
    if (cells.length < 2) {
      errors.push(`第 ${index + 1} 行「${line}」缺少相对水深或流速`)
      return
    }
    const relativeDepth = Number(cells[0])
    const velocityMs = Number(cells[1])
    const durationS = cells.length >= 3 ? Number(cells[2]) : 100
    if (!Number.isFinite(relativeDepth) || relativeDepth < 0 || relativeDepth > 1) {
      errors.push(`第 ${index + 1} 行相对水深应为 0~1 之间的小数`)
      return
    }
    if (!Number.isFinite(velocityMs) || velocityMs < 0) {
      errors.push(`第 ${index + 1} 行流速应为非负数字`)
      return
    }
    if (!Number.isFinite(durationS) || durationS <= 0) {
      errors.push(`第 ${index + 1} 行测速历时应为正数`)
      return
    }
    rows.push({
      relativeDepth: Number(relativeDepth.toFixed(2)),
      velocityMs: Number(velocityMs.toFixed(3)),
      durationS
    })
  })
  return { rows, errors }
}
