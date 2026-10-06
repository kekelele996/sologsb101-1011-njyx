/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbhydrogaug，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（测站 → 断面 → 垂线 → 测点 → 点据 → 比测）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating } from '@/types/rating'
import type { Compare } from '@/types/compare'
import type { CenterArchive, Receipt, SubmissionArchive } from '@/types/submission'
import { buildReceipt, type RatingParams } from '@/types/submission'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'
import { fitPowerCurve } from '@/types/rating'
import { calcMeanVelocity, DEFAULT_WEIGHTS, round } from '@/utils/flow'
import { applyReceiptToSubmission, buildResultSnapshot } from '@/utils/submissionFlow'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbhydrogaug'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbhydrogaug:db-version',
  lastBackupAt: 'gbhydrogaug:last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

/** 备份文件结构，供 utils/export.ts 与导出页使用 */
export interface BackupPayload {
  app: 'gbhydrogaug'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: Rating[]
  compares: Compare[]
  submissions: SubmissionArchive[]
  centerArchives: CenterArchive[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  ratings!: Table<Rating, string>
  compares!: Table<Compare, string>
  /** 测站侧报送档：一测次一行 */
  submissions!: Table<SubmissionArchive, string>
  /** 整编端档：一测次一行，按测次号与测站对上 */
  centerArchives!: Table<CenterArchive, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      stations: 'id, name, river, sectionCode',
      sections: 'id, stationId, measureNo, method',
      verticals: 'id, sectionId, no',
      points: 'id, verticalId, relativeDepth',
      ratings: 'id, stationId, lineNo, stageM',
      compares: 'id, ratingId, verdict'
    })

    // v2：补齐筛选与统计需要的索引（河名/集水面积、水位、测法、偏差判定）
    this.version(2)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
      })
      .upgrade(async (tx) => {
        // 迁移：历史数据补齐时间戳与判定结论，避免列表排序与筛选拿到 undefined
        const stamps: Array<[string, () => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['sections', () => ({ measuredAt: new Date().toISOString() })],
          ['verticals', () => ({ pointCount: 0, bedNote: '' })],
          ['points', () => ({ weight: DEFAULT_WEIGHTS[1], durationS: 100 })],
          ['ratings', () => ({ measureNo: '', lineNo: 'A' })],
          ['compares', () => ({ operator: '', comparedAt: new Date().toISOString() })]
        ]
        for (const [tableName, defaults] of stamps) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, defaults())
            })
        }
      })

    // v3：测流成果报整编——新增测站报送档与整编端档（各留各的档，按测次号对上）
    this.version(DB_VERSION)
      .stores({
        // 既有六表索引不变（Dexie 会自动沿用），仅声明两张新表
        submissions: 'id, sectionId, stationId, measureNo, status, reportSeq, receiptVoided, legacyUnmatched',
        centerArchives: 'id, submissionId, stationId, sectionId, measureNo, status, reportSeq, legacyUnmatched'
      })
      .upgrade(async (tx) => {
        // 旧数据没有报整编标识：按有没有回执回填，认不出的单列出来只读保留。
        const sections = await tx.table<Section>('sections').toArray()
        const verticals = await tx.table<Vertical>('verticals').toArray()
        const points = await tx.table<Point>('points').toArray()
        const ratings = await tx.table<Rating>('ratings').toArray()
        const compares = await tx.table<Compare>('compares').toArray()

        const now = Date.now()
        const submissionRows: SubmissionArchive[] = []
        const centerRows: CenterArchive[] = []

        sections.forEach((section) => {
          // 旧数据本地没有整编端，回填不出真回执，一律按「无回执 → 待整编」处理
          const snapshot = buildResultSnapshot(section, verticals, points, ratings)
          submissionRows.push({
            id: createId('sub'),
            sectionId: section.id,
            stationId: section.stationId,
            measureNo: section.measureNo,
            method: section.method,
            status: '待整编',
            reportSeq: 0,
            reportedAt: null,
            snapshot,
            receipt: null,
            receiptVoided: false,
            voidReason: '',
            rejectReason: '',
            legacyUnmatched: false,
            legacyBackfilled: true,
            createdAt: section.createdAt ?? now,
            updatedAt: now
          })
        })

        // 认不出的旧档：关系点据/比测里存在、但在断面表中找不到对应测次号的，单列只读保留
        const sectionMeasureNos = new Set(sections.map((section) => section.measureNo))
        const unmatchedNos = new Set<string>()
        ratings.forEach((rating) => {
          if (rating.measureNo && !sectionMeasureNos.has(rating.measureNo)) unmatchedNos.add(rating.measureNo)
        })
        let unmatchedIndex = 0
        unmatchedNos.forEach((measureNo) => {
          unmatchedIndex += 1
          const rating = ratings.find((item) => item.measureNo === measureNo)
          const compare = rating ? compares.find((item) => item.ratingId === rating.id) ?? null : null
          const baseId = `sub_legacy_${unmatchedIndex}`
          const common = {
            sectionId: '',
            stationId: rating?.stationId ?? '',
            measureNo,
            method: '',
            reportSeq: 0,
            reportedAt: rating?.measuredAt ?? null,
            snapshot: rating
              ? {
                  stageM: rating.stageM,
                  measuredFlow: rating.flowM3s,
                  areaM2: 0,
                  meanVelocityMs: 0,
                  verticalCount: 0,
                  pointCount: 0,
                  stationParams: null
                }
              : null,
            legacyUnmatched: true,
            legacyBackfilled: true
          }
          let receipt: SubmissionArchive['receipt'] = null
          if (compare) {
            const adopted: RatingParams = {
              lineNo: rating?.lineNo ?? 'A',
              a: 0,
              b: 0,
              h0: 0
            }
            receipt = {
              receiptNo: `HZ-LEGACY-${String(unmatchedIndex).padStart(3, '0')}`,
              receiptAt: compare.comparedAt,
              editor: compare.operator || '历史资料',
              adoptedParams: adopted,
              ratedFlow: compare.curveFlow,
              residualPct: compare.deviationPct,
              verdict: compare.verdict,
              paramsChanged: false,
              note: '升级回填：旧比测记录识别出的回执，定线参数已不可考'
            }
          }
          submissionRows.push({
            ...common,
            id: baseId,
            status: receipt ? '完成' : '待整编',
            receipt,
            receiptVoided: false,
            voidReason: '',
            rejectReason: '',
            createdAt: rating?.createdAt ?? now,
            updatedAt: now
          })
          centerRows.push({
            id: `cen_legacy_${unmatchedIndex}`,
            submissionId: baseId,
            stationId: rating?.stationId ?? '',
            sectionId: '',
            measureNo,
            method: '',
            status: receipt ? '完成' : '待整编',
            reportSeq: 0,
            receivedAt: rating?.measuredAt ?? null,
            lastReceivedAt: rating?.measuredAt ?? null,
            snapshot: null,
            receipt,
            remarks: [],
            legacyUnmatched: true,
            createdAt: rating?.createdAt ?? now,
            updatedAt: now
          })
        })

        if (submissionRows.length > 0) await tx.table('submissions').bulkPut(submissionRows)
        if (centerRows.length > 0) await tx.table('centerArchives').bulkPut(centerRows)
      })
  }
}

export const db = new HydroGaugeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedStationBundle {
  station: Omit<Station, 'createdAt' | 'updatedAt'>
  sections: Array<Omit<Section, 'createdAt' | 'updatedAt'>>
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>
  points: Array<Omit<Point, 'createdAt' | 'updatedAt'>>
}

/**
 * 播种演示数据：3 个测站 → 4 个断面测次 → 8 条垂线 → 16 个流速测点，
 * 并据此生成水位流量关系点据与比测记录，保证父 → 子 → 孙三层链路可点开。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const stationBundles: SeedStationBundle[] = [
    {
      station: {
        id: 'stn_lh01',
        name: '龙门水文站',
        river: '澜沧江',
        catchmentKm2: 45200,
        sectionCode: 'CS-LM-01',
        remark: '基本水文站，缆道测流，断面稳定'
      },
      sections: [
        {
          id: 'sec_lh_2406',
          stationId: 'stn_lh01',
          measureNo: '2024-06-001',
          startDistanceM: 12.5,
          stageM: 5.42,
          method: '流速仪',
          measuredAt: '2024-06-12T08:30:00.000Z'
        },
        {
          id: 'sec_lh_2407',
          stationId: 'stn_lh01',
          measureNo: '2024-07-002',
          startDistanceM: 12.5,
          stageM: 6.15,
          method: 'ADCP',
          measuredAt: '2024-07-18T09:10:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床' },
        { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石' },
        { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂' },
        { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽' }
      ],
      points: [
        { id: 'pnt_lh_11', verticalId: 'vrt_lh_1', relativeDepth: 0.2, velocityMs: 0.62, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_12', verticalId: 'vrt_lh_1', relativeDepth: 0.8, velocityMs: 0.48, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_21', verticalId: 'vrt_lh_2', relativeDepth: 0.2, velocityMs: 1.42, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_22', verticalId: 'vrt_lh_2', relativeDepth: 0.6, velocityMs: 1.18, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_23', verticalId: 'vrt_lh_2', relativeDepth: 0.8, velocityMs: 0.96, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_31', verticalId: 'vrt_lh_3', relativeDepth: 0.2, velocityMs: 0.82, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_32', verticalId: 'vrt_lh_3', relativeDepth: 0.8, velocityMs: 0.64, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_41', verticalId: 'vrt_lh_4', relativeDepth: 0.2, velocityMs: 1.86, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_42', verticalId: 'vrt_lh_4', relativeDepth: 0.6, velocityMs: 1.64, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_43', verticalId: 'vrt_lh_4', relativeDepth: 0.8, velocityMs: 1.32, weight: 1 / 3, durationS: 120 }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        remark: '小河站，浮标法为主，洪水期加测'
      },
      sections: [
        {
          id: 'sec_qj_2405',
          stationId: 'stn_qj02',
          measureNo: '2024-05-003',
          startDistanceM: 4.2,
          stageM: 3.18,
          method: '浮标',
          measuredAt: '2024-05-22T07:50:00.000Z'
        },
        {
          id: 'sec_qj_2408',
          stationId: 'stn_qj02',
          measureNo: '2024-08-004',
          startDistanceM: 4.2,
          stageM: 4.36,
          method: '流速仪',
          measuredAt: '2024-08-09T06:40:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 1.1, pointCount: 2, bedNote: '浮标上断面' },
        { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 1.9, pointCount: 2, bedNote: '浮标中泓' },
        { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 1.6, pointCount: 3, bedNote: '涨水期，流速仪三点法' },
        { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 2.4, pointCount: 3, bedNote: '主槽，卵石夹砂' }
      ],
      points: [
        { id: 'pnt_qj_11', verticalId: 'vrt_qj_1', relativeDepth: 0.2, velocityMs: 0.54, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_12', verticalId: 'vrt_qj_1', relativeDepth: 0.8, velocityMs: 0.42, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_21', verticalId: 'vrt_qj_2', relativeDepth: 0.2, velocityMs: 0.88, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_22', verticalId: 'vrt_qj_2', relativeDepth: 0.8, velocityMs: 0.7, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_31', verticalId: 'vrt_qj_3', relativeDepth: 0.2, velocityMs: 1.06, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_32', verticalId: 'vrt_qj_3', relativeDepth: 0.6, velocityMs: 0.92, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_33', verticalId: 'vrt_qj_3', relativeDepth: 0.8, velocityMs: 0.78, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_41', verticalId: 'vrt_qj_4', relativeDepth: 0.2, velocityMs: 1.34, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_42', verticalId: 'vrt_qj_4', relativeDepth: 0.6, velocityMs: 1.2, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_43', verticalId: 'vrt_qj_4', relativeDepth: 0.8, velocityMs: 1.04, weight: 1 / 3, durationS: 100 }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        remark: '巡测断面，与龙门站比测'
      },
      sections: [
        {
          id: 'sec_bs_2406',
          stationId: 'stn_bs03',
          measureNo: '2024-06-005',
          startDistanceM: 18.0,
          stageM: 5.36,
          method: 'ADCP',
          measuredAt: '2024-06-20T10:05:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_bs_1', sectionId: 'sec_bs_2406', no: 1, startDistanceM: 10.0, depthM: 2.6, pointCount: 3, bedNote: 'ADCP 左半断面' },
        { id: 'vrt_bs_2', sectionId: 'sec_bs_2406', no: 2, startDistanceM: 24.0, depthM: 3.4, pointCount: 3, bedNote: 'ADCP 右半断面' }
      ],
      points: [
        { id: 'pnt_bs_11', verticalId: 'vrt_bs_1', relativeDepth: 0.2, velocityMs: 1.22, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_12', verticalId: 'vrt_bs_1', relativeDepth: 0.6, velocityMs: 1.08, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_13', verticalId: 'vrt_bs_1', relativeDepth: 0.8, velocityMs: 0.9, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_21', verticalId: 'vrt_bs_2', relativeDepth: 0.2, velocityMs: 1.46, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_22', verticalId: 'vrt_bs_2', relativeDepth: 0.6, velocityMs: 1.3, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_23', verticalId: 'vrt_bs_2', relativeDepth: 0.8, velocityMs: 1.1, weight: 1 / 3, durationS: 120 }
      ]
    }
  ]

  // 水位流量关系点据：A 线为龙门站主定线，B 线为青矶站定线
  const ratingSeeds: Array<Omit<Rating, 'createdAt' | 'updatedAt'>> = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z' },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z' },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z' },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z' },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z' },
    { id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z' },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z' },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z' },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z' },
    // C 线：含两个明显偏离点，用于演示超限挂红与偏差分析
    { id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z' },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z' }
  ]

  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.submissions, db.centerArchives],
    async () => {
      const stamp = (row: { id: string }): { createdAt: number; updatedAt: number } => ({
        createdAt: now + row.id.length,
        updatedAt: now + row.id.length
      })

      await db.stations.bulkPut(
        stationBundles.map((bundle) => ({ ...bundle.station, ...stamp(bundle.station) }))
      )
      await db.sections.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.sections.map((section) => ({ ...section, ...stamp(section) }))
        )
      )
      await db.verticals.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
        )
      )
      await db.points.bulkPut(
        stationBundles.flatMap((bundle) =>
          bundle.points.map((point) => ({ ...point, ...stamp(point) }))
        )
      )
      await db.ratings.bulkPut(ratingSeeds.map((rating) => ({ ...rating, ...stamp(rating) })))

      // 比测记录：按定线拟合出曲线流量后计算偏差与判定，保证与页面展示一致
      const compares: Compare[] = []
      const lineGroups = new Map<string, Array<{ stageM: number; flowM3s: number }>>()
      ratingSeeds.forEach((rating) => {
        const list = lineGroups.get(rating.lineNo) ?? []
        list.push({ stageM: rating.stageM, flowM3s: rating.flowM3s })
        lineGroups.set(rating.lineNo, list)
      })
      ratingSeeds.forEach((rating) => {
        const fit = fitPowerCurve(lineGroups.get(rating.lineNo) ?? [], rating.lineNo)
        if (!fit.valid) return
        const predicted = round(fit.a * Math.pow(Math.max(rating.stageM - fit.h0, 1e-6), fit.b), 2)
        const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
        compares.push({
          id: `cmp_${rating.id}`,
          ratingId: rating.id,
          measuredFlow: rating.flowM3s,
          curveFlow: predicted,
          deviationPct,
          verdict: judgeDeviation(deviationPct),
          operator: rating.lineNo === 'C' ? '周渝' : '林昭',
          comparedAt: rating.measuredAt,
          createdAt: now,
          updatedAt: now
        })
      })
      await db.compares.bulkPut(compares)
      if (compares.length === 0) {
        await db.compares.put({
          id: 'cmp_fallback',
          ratingId: 'rat_lh_a1',
          measuredFlow: 97.5,
          curveFlow: 100.2,
          deviationPct: calcDeviationPct(97.5, 100.2),
          verdict: judgeDeviation(calcDeviationPct(97.5, 100.2)),
          operator: '林昭',
          comparedAt: iso,
          createdAt: now,
          updatedAt: now
        })
      }

      /* ---------------- 报整编演示档：测站报送档 + 整编端档 ---------------- */
      const allSections = stationBundles.flatMap((bundle) =>
        bundle.sections.map((section) => ({ section, stationId: bundle.station.id }))
      )
      const allVerticals = stationBundles.flatMap((bundle) =>
        bundle.verticals.map((vertical) => ({ ...vertical, createdAt: now, updatedAt: now }))
      )
      const allPoints = stationBundles.flatMap((bundle) =>
        bundle.points.map((point) => ({ ...point, createdAt: now, updatedAt: now }))
      )
      const submissionRows: SubmissionArchive[] = []
      const centerRows: CenterArchive[] = []

      const snapshotOf = (sectionId: string) => {
        const section = allSections.find((item) => item.section.id === sectionId)?.section
        if (!section) return null
        const stamped: Section = { ...section, createdAt: now, updatedAt: now }
        const stampedRatings: Rating[] = ratingSeeds.map((rating) => ({ ...rating, createdAt: now, updatedAt: now }))
        return buildResultSnapshot(stamped, allVerticals, allPoints, stampedRatings)
      }

      /** 成对落档：测站报送档与整编端档各一份，按测次号对上 */
      const pairPut = (submission: SubmissionArchive, center: CenterArchive): void => {
        submissionRows.push(submission)
        centerRows.push(center)
      }

      // 1) sec_lh_2406：已完成，回执未动定线参数
      {
        const section = allSections.find((item) => item.section.id === 'sec_lh_2406')!.section
        const snapshot = snapshotOf(section.id)!
        const adopted: RatingParams = { ...snapshot.stationParams! }
        const receipt = buildReceipt({
          receiptNo: 'HZ-2024-0601',
          receiptAt: '2024-06-13T10:00:00.000Z',
          editor: '整编室·何渠',
          adoptedParams: adopted,
          snapshot,
          note: '点据贴合 A 线，按原拟合参数整编'
        })
        pairPut(
          {
            id: 'sub_lh_2406',
            sectionId: section.id,
            stationId: section.stationId,
            measureNo: section.measureNo,
            method: section.method,
            status: '完成',
            reportSeq: 1,
            reportedAt: '2024-06-12T12:00:00.000Z',
            snapshot,
            receipt,
            receiptVoided: false,
            voidReason: '',
            rejectReason: '',
            legacyUnmatched: false,
            legacyBackfilled: false,
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'cen_lh_2406',
            submissionId: 'sub_lh_2406',
            stationId: section.stationId,
            sectionId: section.id,
            measureNo: section.measureNo,
            method: section.method,
            status: '完成',
            reportSeq: 1,
            receivedAt: '2024-06-12T12:00:00.000Z',
            lastReceivedAt: '2024-06-12T12:00:00.000Z',
            snapshot,
            receipt,
            remarks: [],
            legacyUnmatched: false,
            createdAt: now,
            updatedAt: now
          }
        )
      }

      // 2) sec_lh_2407：整编中（成果已报，回执未到）
      {
        const section = allSections.find((item) => item.section.id === 'sec_lh_2407')!.section
        const snapshot = snapshotOf(section.id)!
        pairPut(
          {
            id: 'sub_lh_2407',
            sectionId: section.id,
            stationId: section.stationId,
            measureNo: section.measureNo,
            method: section.method,
            status: '整编中',
            reportSeq: 1,
            reportedAt: '2024-07-18T11:20:00.000Z',
            snapshot,
            receipt: null,
            receiptVoided: false,
            voidReason: '',
            rejectReason: '',
            legacyUnmatched: false,
            legacyBackfilled: false,
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'cen_lh_2407',
            submissionId: 'sub_lh_2407',
            stationId: section.stationId,
            sectionId: section.id,
            measureNo: section.measureNo,
            method: section.method,
            status: '整编中',
            reportSeq: 1,
            receivedAt: '2024-07-18T11:20:00.000Z',
            lastReceivedAt: '2024-07-18T11:20:00.000Z',
            snapshot,
            receipt: null,
            remarks: [],
            legacyUnmatched: false,
            createdAt: now,
            updatedAt: now
          }
        )
      }

      // 3) sec_qj_2408：已完成，整编端动过定线参数（测站已按新参数重算）
      {
        const section = allSections.find((item) => item.section.id === 'sec_qj_2408')!.section
        const snapshot = snapshotOf(section.id)!
        const station = snapshot.stationParams!
        const adopted: RatingParams = {
          lineNo: station.lineNo,
          a: Number((station.a * 0.96).toFixed(4)),
          b: station.b,
          h0: Number((station.h0 - 0.05).toFixed(3))
        }
        const receipt = buildReceipt({
          receiptNo: 'HZ-2024-0804',
          receiptAt: '2024-08-10T09:30:00.000Z',
          editor: '整编室·何渠',
          adoptedParams: adopted,
          snapshot,
          note: '洪水绳套回落段偏右，基线 H0 下调 0.05 m、系数 a 折减 4%'
        })
        const reapplied = applyReceiptToSubmission(
          {
            id: 'sub_qj_2408',
            sectionId: section.id,
            stationId: section.stationId,
            measureNo: section.measureNo,
            method: section.method,
            status: '整编中',
            reportSeq: 1,
            reportedAt: '2024-08-09T08:00:00.000Z',
            snapshot,
            receipt: null,
            receiptVoided: false,
            voidReason: '',
            rejectReason: '',
            legacyUnmatched: false,
            legacyBackfilled: false,
            createdAt: now,
            updatedAt: now
          },
          receipt
        )
        pairPut(
          reapplied,
          {
            id: 'cen_qj_2408',
            submissionId: 'sub_qj_2408',
            stationId: section.stationId,
            sectionId: section.id,
            measureNo: section.measureNo,
            method: section.method,
            status: '完成',
            reportSeq: 1,
            receivedAt: '2024-08-09T08:00:00.000Z',
            lastReceivedAt: '2024-08-09T08:00:00.000Z',
            snapshot,
            receipt: reapplied.receipt,
            remarks: [],
            legacyUnmatched: false,
            createdAt: now,
            updatedAt: now
          }
        )
      }

      // 4) sec_qj_2405：被驳回（只重发整编端那份，垂线测点照旧）
      {
        const section = allSections.find((item) => item.section.id === 'sec_qj_2405')!.section
        const snapshot = snapshotOf(section.id)!
        pairPut(
          {
            id: 'sub_qj_2405',
            sectionId: section.id,
            stationId: section.stationId,
            measureNo: section.measureNo,
            method: section.method,
            status: '驳回',
            reportSeq: 1,
            reportedAt: '2024-05-22T09:00:00.000Z',
            snapshot,
            receipt: null,
            receiptVoided: false,
            voidReason: '',
            rejectReason: '浮标系数取用偏大，请核对水面流速系数后重报',
            legacyUnmatched: false,
            legacyBackfilled: false,
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'cen_qj_2405',
            submissionId: 'sub_qj_2405',
            stationId: section.stationId,
            sectionId: section.id,
            measureNo: section.measureNo,
            method: section.method,
            status: '驳回',
            reportSeq: 1,
            receivedAt: '2024-05-22T09:00:00.000Z',
            lastReceivedAt: '2024-05-22T09:00:00.000Z',
            snapshot,
            receipt: null,
            remarks: [
              {
                at: '2024-05-23T15:00:00.000Z',
                editor: '整编室·何渠',
                note: '驳回：浮标系数取用偏大，请核对水面流速系数后重报'
              }
            ],
            legacyUnmatched: false,
            createdAt: now,
            updatedAt: now
          }
        )
      }

      // 5) sec_bs_2406：回执到过后测站又改了测点，回执作废、退回待整编
      {
        const section = allSections.find((item) => item.section.id === 'sec_bs_2406')!.section
        const snapshot = snapshotOf(section.id)!
        const receipt = buildReceipt({
          receiptNo: 'HZ-2024-0605',
          receiptAt: '2024-06-21T14:00:00.000Z',
          editor: '整编室·周渝',
          adoptedParams: { ...snapshot.stationParams! },
          snapshot,
          note: '初整编通过'
        })
        pairPut(
          {
            id: 'sub_bs_2406',
            sectionId: section.id,
            stationId: section.stationId,
            measureNo: section.measureNo,
            method: section.method,
            status: '待整编',
            reportSeq: 1,
            reportedAt: '2024-06-20T11:00:00.000Z',
            snapshot,
            // 回执留痕（作废后仍可查看），以 receiptVoided 标识
            receipt,
            receiptVoided: true,
            voidReason: '测站于 2024-06-22 改动了 2 号垂线的流速测点，原回执作废',
            rejectReason: '',
            legacyUnmatched: false,
            legacyBackfilled: false,
            createdAt: now,
            updatedAt: now
          },
          {
            id: 'cen_bs_2406',
            submissionId: 'sub_bs_2406',
            stationId: section.stationId,
            sectionId: section.id,
            measureNo: section.measureNo,
            method: section.method,
            status: '待整编',
            reportSeq: 1,
            receivedAt: '2024-06-20T11:00:00.000Z',
            lastReceivedAt: '2024-06-20T11:00:00.000Z',
            snapshot,
            receipt: null,
            remarks: [
              {
                at: '2024-06-22T08:30:00.000Z',
                editor: '系统',
                note: '测站改动垂线 / 流速测点，回执 HZ-2024-0605 作废，等待重报'
              }
            ],
            legacyUnmatched: false,
            createdAt: now,
            updatedAt: now
          }
        )
      }

      // 6) 升级回填演示：认不出测次的旧档，单列只读保留（2 份带旧回执、1 份无回执）
      const legacyRows: Array<{ no: string; measureNo: string; stage: number; flow: number; line: string; receipt: boolean; over?: boolean }> = [
        { no: '1', measureNo: '2023-10-017', stage: 6.88, flow: 398.2, line: 'A', receipt: true },
        { no: '2', measureNo: '2023-09-012', stage: 5.02, flow: 132.6, line: 'B', receipt: true, over: true },
        { no: '3', measureNo: '2023-11-021', stage: 7.41, flow: 471.5, line: 'A', receipt: false }
      ]
      legacyRows.forEach((item) => {
        const subId = `sub_legacy_${item.no}`
        const rated = Number((item.flow * (item.over ? 1.13 : 1.01)).toFixed(2))
        const deviation = calcDeviationPct(item.flow, rated)
        const receipt: Receipt | null = item.receipt
          ? {
              receiptNo: `HZ-LEGACY-${item.no.padStart(3, '0')}`,
              receiptAt: '2023-12-01T08:00:00.000Z',
              editor: '历史资料',
              adoptedParams: { lineNo: item.line, a: 0, b: 0, h0: 0 },
              ratedFlow: rated,
              residualPct: deviation,
              verdict: judgeDeviation(deviation),
              paramsChanged: false,
              note: '升级回填：旧比测记录识别出的回执，定线参数已不可考'
            }
          : null
        submissionRows.push({
          id: subId,
          sectionId: '',
          stationId: '',
          measureNo: item.measureNo,
          method: '流速仪',
          status: item.receipt ? '完成' : '待整编',
          reportSeq: 0,
          reportedAt: null,
          snapshot: {
            stageM: item.stage,
            measuredFlow: item.flow,
            areaM2: 0,
            meanVelocityMs: 0,
            verticalCount: 0,
            pointCount: 0,
            stationParams: null
          },
          receipt,
          receiptVoided: false,
          voidReason: '',
          rejectReason: '',
          legacyUnmatched: true,
          legacyBackfilled: true,
          createdAt: now,
          updatedAt: now
        })
        centerRows.push({
          id: `cen_legacy_${item.no}`,
          submissionId: subId,
          stationId: '',
          sectionId: '',
          measureNo: item.measureNo,
          method: '流速仪',
          status: item.receipt ? '完成' : '待整编',
          reportSeq: 0,
          receivedAt: null,
          lastReceivedAt: null,
          snapshot: null,
          receipt,
          remarks: [],
          legacyUnmatched: true,
          createdAt: now,
          updatedAt: now
        })
      })

      await db.submissions.bulkPut(submissionRows)
      await db.centerArchives.bulkPut(centerRows)
    }
  )
}

/** 打开数据库并幂等播种：仅当测站表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.stations.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.stations,
      db.sections,
      db.verticals,
      db.points,
      db.ratings,
      db.compares,
      db.submissions,
      db.centerArchives
    ],
    async () => {
      await Promise.all([
        db.stations.clear(),
        db.sections.clear(),
        db.verticals.clear(),
        db.points.clear(),
        db.ratings.clear(),
        db.compares.clear(),
        db.submissions.clear(),
        db.centerArchives.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与导出页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [stations, sections, verticals, points, ratings, compares, submissions, centerArchives] =
    await Promise.all([
      db.stations.count(),
      db.sections.count(),
      db.verticals.count(),
      db.points.count(),
      db.ratings.count(),
      db.compares.count(),
      db.submissions.count(),
      db.centerArchives.count()
    ])
  return { stations, sections, verticals, points, ratings, compares, submissions, centerArchives }
}

/** 写入结构版本号到 localStorage，便于导出页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastStationId)
    else localStorage.setItem(LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

/** 计算某垂线的平均流速（页面与播种共用同一套算法） */
export function verticalMeanVelocity(points: Point[]): number {
  return calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
}
