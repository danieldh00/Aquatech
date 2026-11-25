// Tests van de hulpfuncties van de klantenmodule.
import { describe, expect, it } from 'vitest'
import { addressOneLine, isForeignVat, pillsOf } from '@/modules/klanten/labels'

const base = { customerGroup: '' as const, wholesale: false, businessRequest: '', hasLogin: false, disabled: false }

describe('pillsOf', () => {
  it('toont Particulier voor een gewone klant', () => {
    expect(pillsOf(base).map((pill) => pill.label)).toEqual(['Particulier'])
  })
  it('toont alle pillen in vaste volgorde', () => {
    const labels = pillsOf({ customerGroup: 'zakelijk', wholesale: true, businessRequest: 'aangevraagd', hasLogin: true, disabled: true }).map((pill) => pill.label)
    expect(labels).toEqual(['Zakelijk', 'Groothandel', 'Aanvraag zakelijk', 'Inlog', 'Uitgeschakeld'])
  })
  it('geeft de oude CSS-klassen', () => {
    expect(pillsOf({ ...base, customerGroup: 'zakelijk', wholesale: true }).map((pill) => pill.className)).toEqual(['pill zakelijk', 'pill groothandel'])
  })
})

describe('isForeignVat', () => {
  it('herkent een buitenlands btw-nummer', () => {
    expect(isForeignVat('DE123456789')).toBe(true)
    expect(isForeignVat(' be 0123.456.789 ')).toBe(true)
  })
  it('laat een Nederlands of leeg nummer met rust', () => {
    expect(isForeignVat('NL123456789B01')).toBe(false)
    expect(isForeignVat('nl123456789b01')).toBe(false)
    expect(isForeignVat('')).toBe(false)
    expect(isForeignVat('12345')).toBe(false)
  })
})

describe('addressOneLine', () => {
  it('zet nieuwe regels om in komma\'s', () => {
    expect(addressOneLine('Kerkstraat 1\n1234 AB Plaats')).toBe('Kerkstraat 1, 1234 AB Plaats')
    expect(addressOneLine(null)).toBe('')
  })
})
