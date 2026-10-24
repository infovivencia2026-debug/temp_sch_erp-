import { describe, expect, it } from 'vitest'
import { placePanel } from './place'

const phone = { left: 0, top: 0, width: 360, height: 640 }
const rect = (left: number, top: number, width = 120, h = 44) => ({ left, top, right: left + width, bottom: top + h, width })

describe('dropdown placement on a phone', () => {
  it('keeps a wide panel 16px inside both edges', () => {
    const p = placePanel(rect(300, 100), phone, { width: 310, maxHeight: 400 })
    expect(p.left).toBe(34)
    expect(p.width).toBe(310)
    expect(p.left + p.width).toBeLessThanOrEqual(360 - 16)
  })
  it('never wider than the screen minus gutters', () => {
    const p = placePanel(rect(10, 100), phone, { width: 500 })
    expect(p.width).toBe(328)
    expect(p.left).toBe(16)
  })
  it('flips above near the foot and caps height to the room', () => {
    const p = placePanel(rect(20, 560), phone, { width: 200, height: 300, maxHeight: 320 })
    expect(p.up).toBe(true)
    expect(p.maxHeight).toBeLessThanOrEqual(560 - 6 - 16)
  })
  it('a lifted calendar stays fully on screen, keyboard included', () => {
    const withKeyboard = { left: 0, top: 0, width: 360, height: 380 }
    const p = placePanel(rect(20, 300), withKeyboard, { width: 310, height: 340, lift: true, maxHeight: 10_000 })
    expect(p.top!).toBeGreaterThanOrEqual(16)
    expect(p.top! + 340).toBeLessThanOrEqual(380 - 16 + 1)
  })
  it('8px gutters on a desktop', () => {
    const p = placePanel(rect(1000, 100), { left: 0, top: 0, width: 1024, height: 768 }, { width: 300 })
    expect(p.left).toBe(1024 - 300 - 8)
  })
})
