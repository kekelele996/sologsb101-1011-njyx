/**
 * 测站 store：维护测站列表、当前选中测站与测站台账筛选条件。
 * 数据经 utils/db.ts 的 Dexie 表订阅实时刷新，页面只读消费。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, readLastStationId, watchTable, writeLastStationId } from '@/utils/db'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import { createEmptyStationFilter, type StationFilterState } from '@/types/station'

export const useStationStore = defineStore('station', () => {
  const stations = ref<Station[]>([])
  const sections = ref<Section[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const currentStationId = ref<string | null>(readLastStationId())
  const filter = ref<StationFilterState>(createEmptyStationFilter())

  let started = false

  /** 启动 IndexedDB 实时订阅（幂等） */
  function start(): void {
    if (started) return
    started = true
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
      ready.value = true
      error.value = null
      if (currentStationId.value === null && rows.length > 0) {
        selectStation(rows[0].id)
      }
    })
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
    })
  }

  const currentStation = computed<Station | null>(
    () => stations.value.find((station) => station.id === currentStationId.value) ?? null
  )

  /** 全部可选河名（筛选下拉与表单联想共用） */
  const riverOptions = computed<string[]>(() =>
    Array.from(new Set(stations.value.map((station) => station.river))).sort((a, b) => a.localeCompare(b))
  )

  /** 测站 id → 测次数量、最新水位与最新测次时间 */
  const sectionStats = computed<
    Record<string, { count: number; latestStageM: number | null; latestMeasuredAt: string | null }>
  >(() => {
    const stats: Record<string, { count: number; latestStageM: number | null; latestMeasuredAt: string | null }> = {}
    sections.value.forEach((section) => {
      const bucket = stats[section.stationId] ?? { count: 0, latestStageM: null, latestMeasuredAt: null }
      bucket.count += 1
      const time = Date.parse(section.measuredAt)
      const lastTime = bucket.latestMeasuredAt ? Date.parse(bucket.latestMeasuredAt) : -Infinity
      if (bucket.latestMeasuredAt === null || time >= lastTime) {
        bucket.latestStageM = section.stageM
        bucket.latestMeasuredAt = section.measuredAt
      }
      stats[section.stationId] = bucket
    })
    return stats
  })

  /** 按筛选条件过滤后的测站 */
  const filteredStations = computed<Station[]>(() =>
    stations.value.filter((station) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${station.name}${station.river}${station.sectionCode}${station.remark}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.rivers.length > 0 && !filter.value.rivers.includes(station.river)) return false
      if (filter.value.minCatchmentKm2 !== null && station.catchmentKm2 < filter.value.minCatchmentKm2) return false
      if (filter.value.maxCatchmentKm2 !== null && station.catchmentKm2 > filter.value.maxCatchmentKm2) return false
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.rivers.length > 0 ||
      filter.value.minCatchmentKm2 !== null ||
      filter.value.maxCatchmentKm2 !== null
  )

  /** 合计集水面积（km²） */
  const totalCatchmentKm2 = computed<number>(() =>
    Number(filteredStations.value.reduce((sum, station) => sum + station.catchmentKm2, 0).toFixed(1))
  )

  function patchFilter(patch: Partial<StationFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyStationFilter()
  }

  function selectStation(id: string | null): void {
    currentStationId.value = id
    writeLastStationId(id)
  }

  function stationById(id: string | null | undefined): Station | null {
    if (!id) return null
    return stations.value.find((station) => station.id === id) ?? null
  }

  async function createStation(payload: Omit<Station, 'id' | 'createdAt' | 'updatedAt'>): Promise<Station> {
    const now = Date.now()
    const row: Station = { ...payload, id: createId('stn'), createdAt: now, updatedAt: now }
    await db.stations.put(row)
    return row
  }

  async function updateStation(id: string, patch: Partial<Station>): Promise<void> {
    await db.stations.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /** 删除测站：级联删除其断面、垂线、测点、点据与比测记录 */
  async function removeStation(id: string): Promise<void> {
    await db.transaction(
      'rw',
      [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares],
      async () => {
        const sectionIds = (await db.sections.where('stationId').equals(id).toArray()).map((row) => row.id)
        const verticalIds =
          sectionIds.length > 0
            ? (await db.verticals.where('sectionId').anyOf(sectionIds).toArray()).map((row) => row.id)
            : []
        if (verticalIds.length > 0) {
          await db.points.where('verticalId').anyOf(verticalIds).delete()
        }
        if (sectionIds.length > 0) {
          await db.verticals.where('sectionId').anyOf(sectionIds).delete()
          await db.sections.where('stationId').equals(id).delete()
        }
        const ratingIds = (await db.ratings.where('stationId').equals(id).toArray()).map((row) => row.id)
        if (ratingIds.length > 0) {
          await db.compares.where('ratingId').anyOf(ratingIds).delete()
          await db.ratings.where('stationId').equals(id).delete()
        }
        await db.stations.delete(id)
      }
    )
    if (currentStationId.value === id) selectStation(null)
  }

  return {
    stations,
    sections,
    ready,
    error,
    currentStationId,
    currentStation,
    filter,
    riverOptions,
    sectionStats,
    filteredStations,
    hasFilter,
    totalCatchmentKm2,
    start,
    patchFilter,
    resetFilter,
    selectStation,
    stationById,
    createStation,
    updateStation,
    removeStation
  }
})
