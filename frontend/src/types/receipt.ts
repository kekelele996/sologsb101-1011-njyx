/**
 * 整编回执：整编端受理测流成果后出具的归档凭证。
 * 测站与整编端各留各的档，两边按测次号（measureNo）对上。
 * 回执写明采用的定线参数（a / b / H0）与整编流量；动过参数的，测站按回执参数重算。
 */

/** 整编回执状态（整编侧出具，决定测次整编状态） */
export type ReceiptStatus = 'accepted' | 'rejected' | 'withdrawn' | 'void'

export const RECEIPT_STATUS_LABELS: Record<ReceiptStatus, string> = {
  accepted: '受理',
  rejected: '驳回',
  withdrawn: '撤回',
  void: '作废'
}

export const RECEIPT_STATUS_COLORS: Record<ReceiptStatus, 'success' | 'danger' | 'warning' | 'info'> = {
  accepted: 'success',
  rejected: 'danger',
  withdrawn: 'warning',
  void: 'info'
}

/** 测次整编状态（测站侧）：回执到了才算完成 */
export type CompileStatus = 'pending' | 'submitted' | 'accepted'

export const COMPILE_STATUS_LABELS: Record<CompileStatus, string> = {
  pending: '待整编',
  submitted: '已报整编',
  accepted: '已完成'
}

export const COMPILE_STATUS_COLORS: Record<CompileStatus, 'info' | 'warning' | 'success'> = {
  pending: 'info',
  submitted: 'warning',
  accepted: 'success'
}

/** 整编回执：一条测次成果对应一份回执（可有多份历史，最新一份决定当前状态） */
export interface Receipt {
  id: string
  /** 测次号：测站与整编端对账的键 */
  measureNo: string
  /** 所属测站 */
  stationId: string
  /** 测站侧断面测次 id */
  sectionId: string
  /** 回执状态 */
  status: ReceiptStatus
  /** 采用的定线号 */
  lineNo: string
  /** 采用的定线系数 a */
  a: number
  /** 采用的定线指数 b */
  b: number
  /** 采用的基线水位 H0（m） */
  h0: number
  /** 整编流量（m³/s）：按采用参数在测次水位处推求 */
  compiledFlowM3s: number
  /** 平均残差（%） */
  meanResidualPct: number
  /** 最大残差（%） */
  maxResidualPct: number
  /** 参与定线点数 */
  sampleCount: number
  /** 整编人 */
  operator: string
  /** 回执出具时间 */
  receivedAt: string
  /** 备注（驳回 / 撤回原因等） */
  note: string
  createdAt: number
  updatedAt: number
}

/** 出具回执时的入参（整编端采用的定线参数） */
export interface ReceiptParams {
  lineNo: string
  a: number
  b: number
  h0: number
  compiledFlowM3s: number
  meanResidualPct: number
  maxResidualPct: number
  sampleCount: number
  operator: string
  note: string
}
