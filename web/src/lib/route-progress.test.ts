import { describe, expect, it } from 'vitest'
import { distanceText, routeLine, routeProgress, type ProgressStop } from './route-progress'

/* A straight road running north, one stop every ~500 m. */
const STOPS: ProgressStop[] = [
  { id: 'a', name: 'School', sequence: 1, latitude: 17.5000, longitude: 78.4000 },
  { id: 'b', name: 'Tank Bund', sequence: 2, latitude: 17.5045, longitude: 78.4000 },
  { id: 'c', name: 'Clock Tower', sequence: 3, latitude: 17.5090, longitude: 78.4000 },
  { id: 'd', name: 'Kompally', sequence: 4, latitude: 17.5135, longitude: 78.4000 },
]

describe('routeProgress', () => {
  it('puts everything ahead when the bus has not reported', () => {
    const p = routeProgress(STOPS)
    expect(p.nearest).toBe(-1)
    expect(p.passed).toEqual([])
    expect(p.ahead.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(p.metresToNext).toBeUndefined()
  })

  it('sorts by sequence whatever order the stops arrive in', () => {
    const shuffled = [STOPS[2], STOPS[0], STOPS[3], STOPS[1]]
    expect(routeProgress(shuffled).ahead.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(routeLine(shuffled)[0]).toEqual([78.4, 17.5])
  })

  it('a bus between two stops has left the one behind it', () => {
    // 100 m north of Tank Bund: nearest is b, and b is passed.
    const p = routeProgress(STOPS, 17.5054, 78.4)
    expect(p.nearest).toBe(1)
    expect(p.passed.map((s) => s.id)).toEqual(['a', 'b'])
    expect(p.ahead[0].id).toBe('c')
    expect(p.metresToNext).toBeGreaterThan(350)
    expect(p.metresToNext).toBeLessThan(450)
  })

  it('a bus nearer the stop ahead is still behind it', () => {
    // 100 m south of Clock Tower: nearest is c, but c is not yet reached.
    const p = routeProgress(STOPS, 17.5081, 78.4)
    expect(p.nearest).toBe(2)
    expect(p.passed.map((s) => s.id)).toEqual(['a', 'b'])
    expect(p.ahead[0].id).toBe('c')
  })

  it('a bus sitting at a stop has that stop as next, not passed', () => {
    const p = routeProgress(STOPS, 17.50902, 78.40001)
    expect(p.passed.map((s) => s.id)).toEqual(['a', 'b'])
    expect(p.ahead[0].id).toBe('c')
    expect(p.metresToNext).toBeLessThan(10)
  })

  it('a bus past the last stop has nothing ahead', () => {
    const p = routeProgress(STOPS, 17.52, 78.4)
    expect(p.ahead).toEqual([])
    expect(p.passed.length).toBe(4)
    expect(p.metresToNext).toBeUndefined()
  })
})

describe('distanceText', () => {
  it('reads as a person says it', () => {
    expect(distanceText(undefined)).toBe('—')
    expect(distanceText(340.4)).toBe('340 m')
    expect(distanceText(999)).toBe('999 m')
    expect(distanceText(1000)).toBe('1.0 km')
    expect(distanceText(2340)).toBe('2.3 km')
  })
})
