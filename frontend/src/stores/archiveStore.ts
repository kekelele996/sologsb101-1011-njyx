/**
 * 整编报送 store：维护测站侧报送档与整编端档（各留各的档，按测次号对上）。
 *
 * 生命周期：
 * - submitSection：测站报成果去整编中心（首报/重报），两侧各落一份，状态「整编中」。
 * - approveAtCenter：整编端收下成果回回执（写明定线参数与整编流量）；动参时测站重算。
 * - rejectAtCenter：整编端驳回，只重发整编端那份，测站垂线/流速测点不动。
 * - withdrawAtCenter：整编端撤回已发回执，只重发整编端那份，测次回到整编中。
 * - 测站改动垂线/流速测点由 utils/submissionFlow.voidReceiptForSection 作废回执、退回待整编。
 * - 认不出的旧档 legacyUnmatched：只读保留，不在任何写动作中处理。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { CenterArchive, Receipt, SubmissionArchive } from '@/types/submission'
import { curveFlowByParams, paramsChanged } from '@/types/submission'
import {
  appendCenterRemark,
  applyReceiptToSubmission,
  buildResultSnapshot
} from '@/utils/submissionFlow'
import type { RatingParams } from '@/types/submission'
import type { Section } from '@/types/section'
import type { Point } from '@/types/point'
import type { Vertical } from '@/types/vertical'
import type { Rating } from '@/types/rating'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'

/** 整编端通过时的入参 */
export interface ApproveInput {
  centerId: string
  editor: string
  adoptedParams: RatingParams
  note?: string
}

export const useArchiveStore = defineStore('archive', () => {
  /** 落库前深拷贝并剥掉 Pinia/Vue 响应式代理（toRaw 只解首层，嵌套快照/回执仍是 Proxy，
   *  IndexedDB 结构化克隆不能复制 Proxy；报送档全是 JSON 可序列化数据，用 JSON 深拷贝最稳） */
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

  const submissions = ref<SubmissionArchive[]>([])
  const centers = ref<CenterArchive[]>([])
  const sections = ref<Section[]>([])
  const verticals = ref<Vertical[]>([])
  const points = ref<Point[]>([])
  const ratings = ref<Rating[]>([])
  const ready = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<SubmissionArchive>(() => db.submissions).subscribe((rows) => {
      submissions.value = rows
      ready.value = true
    })
    watchTable<CenterArchive>(() => db.centerArchives).subscribe((rows) => {
      centers.value = rows
    })
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
    })
    watchTable<Vertical>(() => db.verticals).subscribe((rows) => {
      verticals.value = rows
    })
    watchTable<Point>(() => db.points).subscribe((rows) => {
      points.value = rows
    })
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
    })
  }

  /** 测站侧：按测次 id 查报送档 */
  const submissionBySection = (sectionId: string | null | undefined): SubmissionArchive | null =>
    sectionId ? submissions.value.find((row) => row.sectionId === sectionId) ?? null : null

  /** 整编端：按报送档 id 查整编档 */
  const centerBySubmission = (submissionId: string): CenterArchive | null =>
    centers.value.find((row) => row.submissionId === submissionId) ?? null

  /** 整编端：按测次号对上测站报送档 */
  const submissionByMeasureNo = (measureNo: string): SubmissionArchive | null =>
    submissions.value.find((row) => row.measureNo === measureNo && !row.legacyUnmatched) ?? null

  /** 可操作的整编端档（认不出的旧档只读，不进工作台） */
  const activeCenters = computed<CenterArchive[]>(() =>
    centers.value
      .filter((row) => !row.legacyUnmatched)
      .sort((a, b) => (b.lastReceivedAt ?? '').localeCompare(a.lastReceivedAt ?? ''))
  )

  /** 认不出的旧档：单列只读保留（两侧各取） */
  const legacySubmissions = computed<SubmissionArchive[]>(() =>
    submissions.value
      .filter((row) => row.legacyUnmatched)
      .sort((a, b) => a.measureNo.localeCompare(b.measureNo))
  )
  const legacyCenters = computed<CenterArchive[]>(() =>
    centers.value.filter((row) => row.legacyUnmatched)
  )

  /** 升级回填但能认出测次的旧档（待整编且无报送时间） */
  const backfilledPending = computed<SubmissionArchive[]>(() =>
    submissions.value.filter((row) => row.legacyBackfilled && !row.legacyUnmatched && row.reportSeq === 0)
  )

  const pendingCenterCount = computed(
    () => activeCenters.value.filter((row) => row.status === '待整编' || row.status === '整编中' || row.status === '驳回').length
  )

  /** 测站侧各状态数量，供断面列表徽标 */
  const statusCounts = computed(() => {
    const counts = { 待整编: 0, 整编中: 0, 完成: 0, 驳回: 0 }
    submissions.value
      .filter((row) => !row.legacyUnmatched)
      .forEach((row) => {
        counts[row.status] += 1
      })
    return counts
  })

  /**
   * 测站报成果去整编中心：首报自动建档，重报覆盖本侧内容并递增 reportSeq。
   * 两侧各留各的档；驳回 / 撤回后的重发只重新送成果，垂线测点始终留在测站侧。
   */
  async function submitSection(sectionId: string): Promise<SubmissionArchive> {
    const section = sections.value.find((item) => item.id === sectionId)
    if (!section) throw new Error('测次不存在，无法报整编')
    const snapshot = buildResultSnapshot(section, verticals.value, points.value, ratings.value)
    if (snapshot.verticalCount === 0) {
      throw new Error('该测次还没有垂线成果，请先布设垂线并录入流速测点')
    }

    const existing = submissions.value.find((row) => row.sectionId === sectionId && !row.legacyUnmatched)
    const now = Date.now()
    const iso = new Date(now).toISOString()
    const reportSeq = (existing?.reportSeq ?? 0) + 1

    const submission: SubmissionArchive = existing
      ? {
          ...existing,
          status: '整编中',
          reportSeq,
          reportedAt: iso,
          snapshot,
          receipt: null,
          receiptVoided: false,
          voidReason: '',
          rejectReason: '',
          updatedAt: now
        }
      : {
          id: createId('sub'),
          sectionId: section.id,
          stationId: section.stationId,
          measureNo: section.measureNo,
          method: section.method,
          status: '整编中',
          reportSeq: 1,
          reportedAt: iso,
          snapshot,
          receipt: null,
          receiptVoided: false,
          voidReason: '',
          rejectReason: '',
          legacyUnmatched: false,
          legacyBackfilled: false,
          createdAt: now,
          updatedAt: now
        }

    // 整编端那份：已存在则按报送档 id（其次按测次号）对上并刷新（重报），不存在则新建
    const centerExisting =
      centers.value.find((row) => existing && row.submissionId === existing.id) ??
      centers.value.find((row) => row.measureNo === section.measureNo && !row.legacyUnmatched)
    const center: CenterArchive = centerExisting
      ? {
          ...centerExisting,
          status: '整编中',
          reportSeq,
          lastReceivedAt: iso,
          snapshot,
          receipt: null,
          updatedAt: now
        }
      : {
          id: createId('cen'),
          submissionId: submission.id,
          stationId: section.stationId,
          sectionId: section.id,
          measureNo: section.measureNo,
          method: section.method,
          status: '整编中',
          reportSeq: 1,
          receivedAt: iso,
          lastReceivedAt: iso,
          snapshot,
          receipt: null,
          remarks: [],
          legacyUnmatched: false,
          createdAt: now,
          updatedAt: now
        }
    // 报送档可能是升级回填时按测次号预先建的（id 与整编档要对上）
    if (!centerExisting && existing) center.submissionId = existing.id
    if (centerExisting && !existing) {
      // 极端情况：整编端有档、测站档丢失，沿用其 submissionId 无法落档，直接重建引用
      submission.id = centerExisting.submissionId
    }

    await db.transaction('rw', [db.submissions, db.centerArchives], async () => {
      await db.submissions.put(plain(submission))
      await db.centerArchives.put(plain(center))
    })
    return submission
  }

  /**
   * 整编端收下成果、回回执：
   * 写明采用的定线参数与整编流量；动过参数的，测站按新参数重算曲线流量、残差与比测结论。
   */
  async function approveAtCenter(input: ApproveInput): Promise<{ receipt: Receipt; changed: boolean }> {
    const center = centers.value.find((row) => row.id === input.centerId)
    if (!center || center.legacyUnmatched || !center.snapshot) {
      throw new Error('整编端档不可用或缺少成果快照')
    }
    const now = new Date()
    const receipt: Receipt = {
      receiptNo: `HZ-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}-${createId('r').slice(-5).toUpperCase()}`,
      receiptAt: now.toISOString(),
      editor: input.editor.trim() || '整编室',
      adoptedParams: input.adoptedParams,
      ratedFlow: 0,
      residualPct: 0,
      verdict: '合格',
      paramsChanged: false,
      note: input.note ?? ''
    }
    // 用快照补算整编流量 / 残差 / 结论 / 是否动参
    receipt.ratedFlow = curveFlowByParams(input.adoptedParams, center.snapshot.stageM)
    receipt.residualPct = calcDeviationPct(center.snapshot.measuredFlow, receipt.ratedFlow)
    receipt.verdict = judgeDeviation(receipt.residualPct)
    receipt.paramsChanged = paramsChanged(center.snapshot.stationParams, input.adoptedParams)

    const submission =
      submissions.value.find((row) => row.id === center.submissionId) ??
      submissions.value.find((row) => row.measureNo === center.measureNo && !row.legacyUnmatched) ??
      null
    if (!submission) throw new Error('按测次号找不到测站报送档，回执无法送达')

    const updatedSubmission = applyReceiptToSubmission(submission, receipt)
    const updatedCenter: CenterArchive = {
      ...center,
      status: '完成',
      receipt,
      updatedAt: Date.now()
    }

    await db.transaction('rw', [db.submissions, db.centerArchives, db.ratings, db.compares], async () => {
      await db.submissions.put(plain(updatedSubmission))
      await db.centerArchives.put(plain(updatedCenter))
      // 回执的整编流量同步到该测次的比测记录（曲线流量取整编采用值）
      const rating = (await db.ratings.toArray()).find((item) => item.measureNo === center.measureNo)
      if (rating) {
        const existingCompare = await db.compares.where('ratingId').equals(rating.id).first()
        const ts = Date.now()
        await db.compares.put({
          id: existingCompare?.id ?? createId('cmp'),
          ratingId: rating.id,
          measuredFlow: center.snapshot!.measuredFlow,
          curveFlow: receipt.ratedFlow,
          deviationPct: receipt.residualPct,
          verdict: receipt.verdict,
          operator: receipt.editor,
          comparedAt: receipt.receiptAt,
          createdAt: existingCompare?.createdAt ?? ts,
          updatedAt: ts
        })
      }
    })

    return { receipt, changed: receipt.paramsChanged }
  }

  /** 整编端驳回：只重发本侧那份，测站的垂线/流速测点照旧 */
  async function rejectAtCenter(centerId: string, editor: string, reason: string): Promise<void> {
    const center = centers.value.find((row) => row.id === centerId)
    if (!center || center.legacyUnmatched) throw new Error('整编端档不可用')
    const now = Date.now()
    const note = `驳回：${reason.trim() || '成果不符合整编要求'}`
    const updatedCenter: CenterArchive = {
      ...center,
      status: '驳回',
      receipt: null,
      remarks: appendCenterRemark(center, editor.trim() || '整编室', note),
      updatedAt: now
    }
    const submission = submissions.value.find((row) => row.id === center.submissionId)
    await db.transaction('rw', [db.submissions, db.centerArchives], async () => {
      await db.centerArchives.put(plain(updatedCenter))
      if (submission && !submission.legacyUnmatched) {
        await db.submissions.put(
          plain({
            ...submission,
            status: '驳回',
            receipt: null,
            receiptVoided: false,
            voidReason: '',
            rejectReason: reason.trim() || '整编端驳回，请修改后重报',
            updatedAt: now
          })
        )
      }
    })
  }

  /** 整编端撤回已发回执：只重发本侧那份，测次回到整编中，垂线测点照旧 */
  async function withdrawAtCenter(centerId: string, editor: string, reason: string): Promise<void> {
    const center = centers.value.find((row) => row.id === centerId)
    if (!center || center.legacyUnmatched) throw new Error('整编端档不可用')
    const now = Date.now()
    const withdrawnNo = center.receipt?.receiptNo ?? ''
    const updatedCenter: CenterArchive = {
      ...center,
      status: '整编中',
      receipt: null,
      remarks: appendCenterRemark(
        center,
        editor.trim() || '整编室',
        `撤回回执${withdrawnNo ? ` ${withdrawnNo}` : ''}：${reason.trim() || '整编端主动撤回'}`
      ),
      updatedAt: now
    }
    const submission = submissions.value.find((row) => row.id === center.submissionId)
    await db.transaction('rw', [db.submissions, db.centerArchives], async () => {
      await db.centerArchives.put(plain(updatedCenter))
      if (submission && !submission.legacyUnmatched) {
        await db.submissions.put(
          plain({
            ...submission,
            status: '整编中',
            receipt: null,
            receiptVoided: false,
            voidReason: '',
            updatedAt: now
          })
        )
      }
    })
  }

  /** 测站侧读取：该测次是否已有有效回执（完成态以回执为准） */
  function effectiveReceipt(sectionId: string): Receipt | null {
    const row = submissionBySection(sectionId)
    if (!row || row.receiptVoided || row.status !== '完成') return null
    return row.receipt
  }

  return {
    submissions,
    centers,
    sections,
    verticals,
    points,
    ratings,
    ready,
    start,
    submissionBySection,
    centerBySubmission,
    submissionByMeasureNo,
    activeCenters,
    legacySubmissions,
    legacyCenters,
    backfilledPending,
    pendingCenterCount,
    statusCounts,
    submitSection,
    approveAtCenter,
    rejectAtCenter,
    withdrawAtCenter,
    effectiveReceipt
  }
})
