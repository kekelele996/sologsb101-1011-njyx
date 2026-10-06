/**
 * 整编 store：维护整编端出具的回执与测次整编状态。
 * 测站与整编端各留各的档，两边按测次号（measureNo）对上。
 * 回执到了测次才算完成；回执动过定线参数的，测站按回执参数重算曲线流量、残差与比测结论。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Receipt, ReceiptParams, ReceiptStatus } from '@/types/receipt'
import type { Section } from '@/types/section'
import type { RatingFitResult } from '@/types/rating'
import { curveFlow } from '@/types/rating'
import { useRatingStore } from '@/stores/ratingStore'

export const useCompileStore = defineStore('compile', () => {
  const receipts = ref<Receipt[]>([])
  const sections = ref<Section[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Receipt>(() => db.receipts).subscribe((rows) => {
      receipts.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
    })
  }

  /* ------------------------------- 派生查询 ------------------------------- */

  /** 某测次的全部回执（按出具时间倒序） */
  function receiptsOfSection(sectionId: string | null | undefined): Receipt[] {
    if (!sectionId) return []
    return receipts.value
      .filter((receipt) => receipt.sectionId === sectionId)
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
  }

  /** 某测次的最新回执（决定当前整编状态） */
  function latestReceiptOfSection(sectionId: string | null | undefined): Receipt | null {
    return receiptsOfSection(sectionId)[0] ?? null
  }

  /** 按测次号对账：整编端用 */
  function receiptsByMeasureNo(measureNo: string): Receipt[] {
    return receipts.value
      .filter((receipt) => receipt.measureNo === measureNo)
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
  }

  /** 待整编队列：已报整编、等待回执的测次 */
  const compileQueue = computed<Section[]>(() =>
    sections.value
      .filter((section) => section.compileStatus === 'submitted' && !section.legacyReadonly)
      .sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt))
  )

  /** 已完成整编的测次（回执已受理） */
  const completedSections = computed<Section[]>(() =>
    sections.value
      .filter((section) => section.compileStatus === 'accepted' && !section.legacyReadonly)
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  )

  /** 历史遗留只读测次：升级时认不出归属的，单列只读保留 */
  const legacySections = computed<Section[]>(() =>
    sections.value.filter((section) => section.legacyReadonly)
  )

  /** 某测次是否有受理中的回执 */
  function hasAcceptedReceipt(sectionId: string): boolean {
    return latestReceiptOfSection(sectionId)?.status === 'accepted'
  }

  /* ------------------------------- 测站侧动作 ------------------------------- */

  /** 测站报整编：测次成果报去流域整编中心，状态置为已报整编 */
  async function submitForCompile(sectionId: string): Promise<void> {
    const section = sections.value.find((item) => item.id === sectionId)
    if (!section || section.legacyReadonly) return
    await db.sections.update(sectionId, {
      compileStatus: 'submitted',
      updatedAt: Date.now()
    } as never)
  }

  /**
   * 测站改动垂线或流速测点后，回执作废，测次退回待整编。
   * 由 sectionStore 在垂线 / 测点变更后回调。
   */
  async function voidReceipt(sectionId: string): Promise<void> {
    const section = await db.sections.get(sectionId)
    if (!section || section.legacyReadonly) return
    const latest = await db.receipts
      .where('sectionId')
      .equals(sectionId)
      .reverse()
      .sortBy('receivedAt')
      .then((rows) => rows[0] ?? null)
    // 仅当存在已受理或已报整编的回执时才作废
    if (latest && (latest.status === 'accepted' || latest.status === 'rejected' || latest.status === 'withdrawn')) {
      const now = Date.now()
      await db.receipts.put({
        ...latest,
        id: createId('rcp'),
        status: 'void' as ReceiptStatus,
        receivedAt: new Date().toISOString(),
        note: `测站改动垂线 / 流速测点，原回执作废`,
        createdAt: now,
        updatedAt: now
      })
    }
    await db.sections.update(sectionId, {
      compileStatus: 'pending',
      updatedAt: Date.now()
    } as never)
  }

  /* ------------------------------- 整编侧动作 ------------------------------- */

  /**
   * 整编端受理：出具回执，写明采用的定线参数与整编流量。
   * 回执动过参数的，测站按回执参数重算曲线流量、残差与比测结论。
   */
  async function issueReceipt(sectionId: string, params: ReceiptParams): Promise<Receipt> {
    const section = sections.value.find((item) => item.id === sectionId)
    if (!section) throw new Error('测次不存在')
    const now = Date.now()
    const receipt: Receipt = {
      id: createId('rcp'),
      measureNo: section.measureNo,
      stationId: section.stationId,
      sectionId,
      status: 'accepted',
      lineNo: params.lineNo,
      a: params.a,
      b: params.b,
      h0: params.h0,
      compiledFlowM3s: params.compiledFlowM3s,
      meanResidualPct: params.meanResidualPct,
      maxResidualPct: params.maxResidualPct,
      sampleCount: params.sampleCount,
      operator: params.operator,
      receivedAt: new Date().toISOString(),
      note: params.note,
      createdAt: now,
      updatedAt: now
    }
    await db.transaction('rw', [db.receipts, db.sections, db.compares], async () => {
      await db.receipts.put(receipt)
      await db.sections.update(sectionId, {
        compileStatus: 'accepted',
        updatedAt: now
      } as never)
    })
    // 按回执参数重算该定线的曲线流量、残差与比测结论
    const fit: RatingFitResult = {
      lineNo: params.lineNo,
      a: params.a,
      b: params.b,
      h0: params.h0,
      sampleCount: params.sampleCount,
      meanResidualPct: params.meanResidualPct,
      maxResidualPct: params.maxResidualPct,
      r2: 0,
      valid: true,
      message: ''
    }
    const ratingStore = useRatingStore()
    await ratingStore.rebuildComparesWithParams(params.lineNo, fit)
    return receipt
  }

  /** 整编端驳回：只重发本侧那份（出具驳回回执），测站垂线流速测点照旧留着 */
  async function rejectReceipt(sectionId: string, note: string, operator: string): Promise<Receipt> {
    const section = sections.value.find((item) => item.id === sectionId)
    if (!section) throw new Error('测次不存在')
    const now = Date.now()
    const receipt: Receipt = {
      id: createId('rcp'),
      measureNo: section.measureNo,
      stationId: section.stationId,
      sectionId,
      status: 'rejected',
      lineNo: '',
      a: 0,
      b: 0,
      h0: 0,
      compiledFlowM3s: 0,
      meanResidualPct: 0,
      maxResidualPct: 0,
      sampleCount: 0,
      operator,
      receivedAt: new Date().toISOString(),
      note,
      createdAt: now,
      updatedAt: now
    }
    await db.transaction('rw', [db.receipts, db.sections], async () => {
      await db.receipts.put(receipt)
      await db.sections.update(sectionId, {
        compileStatus: 'pending',
        updatedAt: now
      } as never)
    })
    return receipt
  }

  /** 整编端撤回：只重发本侧那份（出具撤回回执），测站垂线流速测点照旧留着 */
  async function withdrawReceipt(sectionId: string, note: string, operator: string): Promise<Receipt> {
    const section = sections.value.find((item) => item.id === sectionId)
    if (!section) throw new Error('测次不存在')
    const now = Date.now()
    const receipt: Receipt = {
      id: createId('rcp'),
      measureNo: section.measureNo,
      stationId: section.stationId,
      sectionId,
      status: 'withdrawn',
      lineNo: '',
      a: 0,
      b: 0,
      h0: 0,
      compiledFlowM3s: 0,
      meanResidualPct: 0,
      maxResidualPct: 0,
      sampleCount: 0,
      operator,
      receivedAt: new Date().toISOString(),
      note,
      createdAt: now,
      updatedAt: now
    }
    await db.transaction('rw', [db.receipts, db.sections], async () => {
      await db.receipts.put(receipt)
      await db.sections.update(sectionId, {
        compileStatus: 'pending',
        updatedAt: now
      } as never)
    })
    return receipt
  }

  /** 由回执参数计算曲线流量（供整编端预览整编流量） */
  function previewCompiledFlow(fit: RatingFitResult, stageM: number): number {
    return curveFlow(fit, stageM)
  }

  return {
    receipts,
    sections,
    ready,
    error,
    start,
    receiptsOfSection,
    latestReceiptOfSection,
    receiptsByMeasureNo,
    compileQueue,
    completedSections,
    legacySections,
    hasAcceptedReceipt,
    submitForCompile,
    voidReceipt,
    issueReceipt,
    rejectReceipt,
    withdrawReceipt,
    previewCompiledFlow
  }
})
