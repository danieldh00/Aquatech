// Tests van de opmaak van bedragen en datums.
import { describe, expect, it } from 'vitest'
import { formatEuro, formatShortDate } from '@/shared/format'

describe('formatEuro', () => {
  it('zet een bedrag in Nederlandse notatie', () => {
    expect(formatEuro(1234.5).replace(/\s/g, ' ')).toBe('€ 1.234,50')
  })
  it('telt onzin als 0', () => {
    expect(formatEuro(null).replace(/\s/g, ' ')).toBe('€ 0,00')
    expect(formatEuro('abc').replace(/\s/g, ' ')).toBe('€ 0,00')
  })
})

describe('formatShortDate', () => {
  it('maakt van een datum dag-maand-jaar', () => {
    expect(formatShortDate('2026-10-22')).toBe('22-10-2026')
  })
  it('geeft leeg zonder datum', () => {
    expect(formatShortDate('')).toBe('')
    expect(formatShortDate(null)).toBe('')
  })
})
