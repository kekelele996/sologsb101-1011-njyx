/**
 * 测流成果报整编的共享业务函数（不依赖 Pinia，store 与升级回填共用）：
 * - buildResultSnapshot：报整编前汇总断面实测成果与测站侧定线参数
 * - applyReceiptToSubmission：回执到达后回写测站报送档（动参则重算曲线流量/残差/结论）
 * - voidReceiptForSection：测站改动垂线 / 流速测点后作废该测次回执
 * 两侧档案各自独立：整编端驳回 / 撤回只改整编端那份，不碰垂线与流速测点。
 */
import { db } from '@/utils/db'
import { calcMeanVelocity, calcSectionDischarge } from '@/utils/flow'
import type { Section } from '@/types/section'
import type { Point } from '@/types/point'
import type { Vertical } from '@/types/vertical'
import {
  fitParamsOf,
  recomputeWithParams,
  type CenterArchive,
  type Receipt,
  type ResultSnapshot,
  type SubmissionArchive
} from '@/types/submission'

/** 汇总一个测次的断面实测成果（部分面积法）与测站侧拟合定线参数 */
export function buildResultSnapshot(
  section: Section,
  verticals: Vertical[],
  points: Point[],
  allRatings: import('@/types/rating').Rating[]
): ResultSnapshot {
  const sectionVerticals = verticals.filter((vertical) => vertical.sectionId === section.id)
  const slices = sectionVerticals
    .map((vertical) => {
      const verticalPoints = points.filter((point) => point.verticalId === vertical.id)
      return {
        id: vertical.id,
        no: vertical.no,
        startDistanceM: vertical.startDistanceM,
        depthM: vertical.depthM,
        meanVelocityMs: calcMeanVelocity(
          verticalPoints.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight }))
        )
      }
    })
    .sort((a, b) => a.startDistanceM - b.startDistanceM)
  const discharge = calcSectionDischarge(slices)

  // 定线参数取该测站、该测次对应关系点据所在定线号的全站拟合（与关系点据页口径一致）
  const ownRating = allRatings.find((rating) => rating.measureNo === section.measureNo)
  const lineNo = ownRating?.lineNo ?? 'A'
  const linePoints = allRatings
    .filter((rating) => rating.stationId === section.stationId && rating.lineNo === lineNo)
    .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s }))
  const stationParams = fitParamsOf(linePoints, lineNo)

  return {
    stageM: section.stageM,
    measuredFlow: discharge.flowM3s,
    areaM2: discharge.areaM2,
    meanVelocityMs: discharge.meanVelocityMs,
    verticalCount: sectionVerticals.length,
    pointCount: sectionVerticals.reduce(
      (sum, vertical) => sum + points.filter((point) => point.verticalId === vertical.id).length,
      0
    ),
    stationParams
  }
}

/**
 * 回执到达测站：回写报送档。
 * - 状态置「完成」，记下回执；
 * - 回执动过定线参数的，按整编端参数重算曲线流量、残差与比测结论；
 * - 清掉之前的驳回 / 作废标记。
 */
export function applyReceiptToSubmission(row: SubmissionArchive, receipt: Receipt): SubmissionArchive {
  const recomputed =
    row.snapshot && receipt.paramsChanged
      ? recomputeWithParams(row.snapshot.measuredFlow, row.snapshot.stageM, receipt.adoptedParams)
      : {
          ratedFlow: receipt.ratedFlow,
          residualPct: receipt.residualPct,
          verdict: receipt.verdict
        }
  const normalizedReceipt: Receipt = receipt.paramsChanged
    ? { ...receipt, ...recomputed }
    : receipt
  return {
    ...row,
    status: '完成',
    receipt: normalizedReceipt,
    receiptVoided: false,
    voidReason: '',
    rejectReason: '',
    updatedAt: Date.now()
  }
}

/**
 * 测站改动垂线或流速测点后调用：该测次已到的回执作废，退回待整编。
 * 只作废回执与状态，垂线 / 测点本身照旧保留；整编端那份由重报后按新成果对上。
 */
export async function voidReceiptForSection(sectionId: string, reason: string): Promise<boolean> {
  const row = await db.submissions.where('sectionId').equals(sectionId).first()
  if (!row || row.legacyUnmatched) return false
  // 还没回执（待整编 / 整编中 / 驳回）不算作废回执，只是内容变了等重报
  if (!row.receipt) return false

  const now = Date.now()
  await db.submissions.update(row.id, {
    status: '待整编',
    receiptVoided: true,
    voidReason: reason,
    updatedAt: now
  } as never)

  // 整编端那份同步标记：旧回执作废、等待该测次重报（不删除整编端留档）
  const center = await db.centerArchives.where('submissionId').equals(row.id).first()
  if (center) {
    await db.centerArchives.update(center.id, {
      status: '待整编',
      receipt: null,
      remarks: [
        ...center.remarks,
        {
          at: new Date(now).toISOString(),
          editor: '系统',
          note: `测站改动垂线 / 流速测点，回执 ${row.receipt.receiptNo} 作废，等待重报：${reason}`
        }
      ],
      updatedAt: now
    } as never)
  }
  return true
}

/** 把整编端处置（驳回 / 撤回通过）追加为一条本侧说明 */
export function appendCenterRemark(
  row: CenterArchive,
  editor: string,
  note: string
): CenterArchive['remarks'] {
  return [...row.remarks, { at: new Date().toISOString(), editor, note }]
}
