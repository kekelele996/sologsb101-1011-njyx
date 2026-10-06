/**
 * 测流成果报整编：测站侧报送档与整编端回执的共享模型。
 *
 * 约定（业务口径）：
 * - 测站与整编端各留各的档：测站侧 SubmissionArchive、整编端 CenterArchive，按测次号对上。
 * - 整编端收下成果后回一份整编回执（Receipt），写明采用的定线参数与整编流量。
 * - 回执到了，这个测次才算完成（完成）。
 * - 回执里动过定线参数的，测站按整编端给的参数重算曲线流量、残差与比测结论。
 * - 测站又改动垂线或流速测点，原回执作废，测次退回待整编，重报后照新回执走。
 * - 整编端驳回或撤回时只重发本侧那份，测站的垂线流速测点照旧留着。
 * - 旧数据没有报整编标识，升级时按有没有回执回填，认不出的单列只读保留。
 */
import type { RatingFitResult } from './rating'
import { curveFlow, fitPowerCurve } from './rating'
import { calcDeviationPct, judgeDeviation, type CompareVerdict } from './compare'

/** 测站侧报送状态 */
export type SubmissionStatus = '待整编' | '整编中' | '完成' | '驳回'

/** 整编端处置动作：通过（带回执）/ 驳回 / 撤回通过 */
export type CenterDecision = '通过' | '驳回'

/** 定线参数：回执里写明整编端采用的一组参数；未动参数时与测站拟合值一致 */
export interface RatingParams {
  /** 定线号，如 A / B / C */
  lineNo: string
  /** 系数 a（Q = a(H-H0)^b） */
  a: number
  /** 指数 b */
  b: number
  /** 基线水位 H0（m） */
  h0: number
}

/** 报送成果快照：报出去的那一刻断面实测成果，整编端驳回 / 撤回不动这一侧 */
export interface ResultSnapshot {
  /** 水位（m） */
  stageM: number
  /** 断面实测流量（m³/s，部分面积法） */
  measuredFlow: number
  /** 断面面积（m²） */
  areaM2: number
  /** 断面平均流速（m/s） */
  meanVelocityMs: number
  /** 垂线条数 */
  verticalCount: number
  /** 流速测点总数 */
  pointCount: number
  /** 报送时测站侧拟合的定线参数 */
  stationParams: RatingParams | null
}

/** 整编回执：整编端收下成果后回的那一份 */
export interface Receipt {
  /** 回执编号 */
  receiptNo: string
  /** 回执出具时间 ISO */
  receiptAt: string
  /** 整编员 */
  editor: string
  /** 整编端采用的定线参数（动过参数则与测站原参数不同） */
  adoptedParams: RatingParams
  /** 整编流量（m³/s）：按采用参数在报送水位处算出的曲线流量 */
  ratedFlow: number
  /** 残差（%）：(实测 - 整编曲线) / 实测 × 100 */
  residualPct: number
  /** 比测结论 */
  verdict: CompareVerdict
  /** 相对测站报送参数，整编端是否动过定线参数 */
  paramsChanged: boolean
  /** 整编意见备注 */
  note: string
}

/**
 * 测站侧报送档（测站自己留的那份）：
 * 一测次一行，重报覆盖本档内容并递增 reportSeq；回执到达后回写 receipt* 字段。
 */
export interface SubmissionArchive {
  id: string
  /** 断面测次 id（本档归属的测次） */
  sectionId: string
  /** 测站 id */
  stationId: string
  /** 测次号：测站与整编端两边按它对上 */
  measureNo: string
  /** 测法 */
  method: string
  status: SubmissionStatus
  /** 第几次报送：驳回 / 作废后重报递增 */
  reportSeq: number
  /** 最近一次报送时间 ISO；从未报送为 null（升级回填前的旧档） */
  reportedAt: string | null
  /** 报出去的成果快照 */
  snapshot: ResultSnapshot | null
  /** 到达的整编回执；无回执为 null */
  receipt: Receipt | null
  /** 回执是否已被测站改动垂线 / 测点作废 */
  receiptVoided: boolean
  /** 回执作废 / 退回原因 */
  voidReason: string
  /** 驳回 / 退回说明（整编端驳回理由或作废提示） */
  rejectReason: string
  /** 升级回填时认不出测次的旧档：true 时只读保留 */
  legacyUnmatched: boolean
  /** 旧数据回填标记：由升级程序按有没有回执回填 */
  legacyBackfilled: boolean
  createdAt: number
  updatedAt: number
}

/** 整编端处置结果（驳回 / 撤回通过时的本侧重发说明） */
export interface CenterRemark {
  /** 处置时间 ISO */
  at: string
  /** 处置人 */
  editor: string
  /** 说明 */
  note: string
}

/**
 * 整编端档（整编中心自己留的那份）：
 * 一测次一行，与测站报送档按测次号对上；驳回 / 撤回只重发本侧这份。
 */
export interface CenterArchive {
  id: string
  /** 对应的测站报送档 id */
  submissionId: string
  stationId: string
  sectionId: string
  /** 测次号：两边对档的键 */
  measureNo: string
  method: string
  /** 整编端处理状态 */
  status: SubmissionStatus
  /** 已收报送次数（重报一次 +1） */
  reportSeq: number
  /** 首次收到时间 ISO */
  receivedAt: string | null
  /** 最近一次收到重报时间 ISO */
  lastReceivedAt: string | null
  /** 最近收到的成果快照（与测站侧一致） */
  snapshot: ResultSnapshot | null
  /** 出具的回执（通过后才有；撤回通过时清空） */
  receipt: Receipt | null
  /** 驳回 / 撤回等本侧处置记录（不动测站垂线测点） */
  remarks: CenterRemark[]
  /** 升级回填时认不出测次的旧档：true 时只读保留 */
  legacyUnmatched: boolean
  createdAt: number
  updatedAt: number
}

/** 报送状态 → 标签配色，供测站列表与整编中心共用 */
export const STATUS_TAG_TYPE: Record<SubmissionStatus, 'success' | 'warning' | 'primary' | 'danger'> = {
  待整编: 'warning',
  整编中: 'primary',
  完成: 'success',
  驳回: 'danger'
}

/** 由一组点据求某定线号的拟合参数（点据不足时返回 null） */
export function fitParamsOf(
  points: Array<{ stageM: number; flowM3s: number }>,
  lineNo: string
): RatingParams | null {
  const fit = fitPowerCurve(points, lineNo)
  if (!fit.valid) return null
  return { lineNo, a: fit.a, b: fit.b, h0: fit.h0 }
}

/** 把一组拟合参数套进 RatingFitResult 形态以复用曲线流量计算 */
function paramsAsFit(params: RatingParams): RatingFitResult {
  return {
    lineNo: params.lineNo,
    a: params.a,
    b: params.b,
    h0: params.h0,
    sampleCount: 0,
    meanResidualPct: 0,
    maxResidualPct: 0,
    r2: 0,
    valid: true,
    message: ''
  }
}

/** 按给定定线参数计算某水位处的曲线（整编）流量 */
export function curveFlowByParams(params: RatingParams, stageM: number): number {
  return curveFlow(paramsAsFit(params), stageM)
}

/** 比较两组定线参数是否被改动（任一系数差异超阈值即算动过） */
export function paramsChanged(stationParams: RatingParams | null, adopted: RatingParams): boolean {
  if (!stationParams) return true
  if (stationParams.lineNo !== adopted.lineNo) return true
  return (
    Math.abs(stationParams.a - adopted.a) > 1e-4 ||
    Math.abs(stationParams.b - adopted.b) > 1e-3 ||
    Math.abs(stationParams.h0 - adopted.h0) > 1e-3
  )
}

/**
 * 按整编端采用参数重算测站侧的曲线流量、残差与比测结论。
 * 测站在收到「动过定线参数」的回执后照此回填。
 */
export function recomputeWithParams(
  measuredFlow: number,
  stageM: number,
  adopted: RatingParams
): { ratedFlow: number; residualPct: number; verdict: CompareVerdict } {
  const ratedFlow = curveFlowByParams(adopted, stageM)
  const residualPct = calcDeviationPct(measuredFlow, ratedFlow)
  return { ratedFlow, residualPct, verdict: judgeDeviation(residualPct) }
}

/** 组装一份回执（自动算整编流量、残差、结论与是否动参） */
export function buildReceipt(input: {
  receiptNo: string
  receiptAt: string
  editor: string
  adoptedParams: RatingParams
  snapshot: ResultSnapshot
  note?: string
}): Receipt {
  const { ratedFlow, residualPct, verdict } = recomputeWithParams(
    input.snapshot.measuredFlow,
    input.snapshot.stageM,
    input.adoptedParams
  )
  return {
    receiptNo: input.receiptNo,
    receiptAt: input.receiptAt,
    editor: input.editor,
    adoptedParams: input.adoptedParams,
    ratedFlow,
    residualPct,
    verdict,
    paramsChanged: paramsChanged(input.snapshot.stationParams, input.adoptedParams),
    note: input.note ?? ''
  }
}

/** 回执状态文案，供页面统一引用 */
export const STATUS_LABEL: Record<SubmissionStatus, string> = {
  待整编: '待整编',
  整编中: '整编中',
  完成: '完成',
  驳回: '驳回'
}
