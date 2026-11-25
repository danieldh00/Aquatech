// Tests van de Excel-export van de klantenlijst: porties ophalen, kolommen en groepsnamen.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExcelLibrary } from '@/shared/shell'
import type { Customer } from '@/modules/klanten/types'

vi.mock('@/modules/klanten/customers-api', () => ({ listCustomers: vi.fn() }))
import { listCustomers } from '@/modules/klanten/customers-api'
import { buildWorkbook, exportCustomersToExcel, fetchAllCustomers, groupLabel } from '@/modules/klanten/export-excel'

/**
 * Maakt een klant met de gegeven afwijkingen.
 * @param overrides Velden die afwijken.
 * @returns Een klant.
 */
function customer(overrides: Partial<Customer> = {}): Customer {
  return { id: 'k1', displayName: 'Jan', username: 'jan', companyName: '', address: 'Straat 1\n1234 AB Plaats', email: 'jan@example.nl', phone: '06', customerGroup: '', wholesale: false, wholesaleDiscount: 0, businessRequest: '', hasLogin: false, disabled: false, kvkNumber: '', vatNumber: '', paymentDays: null, documentLanguage: 'nl', remindersOff: false, ...overrides }
}

/**
 * Een nagebootste Excel-bibliotheek die de gemaakte rijen bewaart.
 * @returns De bibliotheek en de bewaarde gegevens.
 */
function fakeExcel() {
  const captured = { rows: [] as Record<string, unknown>[], columns: [] as { header: string }[], name: '', frozen: null as unknown, bold: false }
  const sheet = {
    set columns(value: { header: string; key: string; width: number }[]) { captured.columns = value },
    get columns() { return captured.columns as never },
    addRow: (row: Record<string, unknown>) => { captured.rows.push(row) },
    getRow: () => ({ set font(value: Record<string, unknown>) { captured.bold = value.bold === true } }) as never,
    set views(value: Record<string, unknown>[]) { captured.frozen = value },
    get views() { return captured.frozen as never },
  }
  const library = { Workbook: class { addWorksheet(name: string) { captured.name = name; return sheet as never } xlsx = { writeBuffer: async () => new ArrayBuffer(8) } } } as unknown as ExcelLibrary
  return { library, captured }
}

afterEach(() => { vi.clearAllMocks(); delete (window as unknown as Record<string, unknown>).AquatechCommon })

describe('groupLabel', () => {
  it('geeft de groep waaronder de klant valt', () => {
    expect(groupLabel(customer({ wholesale: true, customerGroup: 'zakelijk' }))).toBe('Groothandel')
    expect(groupLabel(customer({ customerGroup: 'zakelijk' }))).toBe('Zakelijk')
    expect(groupLabel(customer())).toBe('Particulier')
  })
})

describe('fetchAllCustomers', () => {
  it('haalt in porties van 200 op tot alles binnen is en geeft zoekwoord en filter door', async () => {
    const first = Array.from({ length: 200 }, (_, index) => customer({ id: `a${index}` }))
    const second = Array.from({ length: 50 }, (_, index) => customer({ id: `b${index}` }))
    vi.mocked(listCustomers).mockResolvedValueOnce({ items: first, total: 250 }).mockResolvedValueOnce({ items: second, total: 250 })
    const all = await fetchAllCustomers('jan', 'zakelijk')
    expect(all).toHaveLength(250)
    expect(listCustomers).toHaveBeenNthCalledWith(1, { search: 'jan', group: 'zakelijk', limit: 200, offset: 0 })
    expect(listCustomers).toHaveBeenNthCalledWith(2, { search: 'jan', group: 'zakelijk', limit: 200, offset: 200 })
  })
  it('stopt bij een lege portie', async () => {
    vi.mocked(listCustomers).mockResolvedValueOnce({ items: [], total: 5 })
    expect(await fetchAllCustomers('', '')).toEqual([])
    expect(listCustomers).toHaveBeenCalledTimes(1)
  })
})

describe('buildWorkbook', () => {
  it('maakt blad Klanten met dezelfde kolommen en regels als de oude export', () => {
    const { library, captured } = fakeExcel()
    buildWorkbook(library, [customer({ wholesale: true, wholesaleDiscount: 7.5, hasLogin: true, customerGroup: 'zakelijk' })])
    expect(captured.name).toBe('Klanten')
    expect(captured.columns.map((column) => column.header)).toEqual(['Naam', 'Bedrijf', 'KvK', 'Btw-nummer', 'Adres', 'E-mail', 'Telefoon', 'Groep', 'Groothandelskorting %', 'Inlog'])
    expect(captured.rows[0]).toMatchObject({ displayName: 'Jan', address: 'Straat 1, 1234 AB Plaats', group: 'Groothandel', discount: 7.5, login: 'ja' })
    expect(captured.bold).toBe(true)
    expect(captured.frozen).toEqual([{ state: 'frozen', ySplit: 1 }])
  })
  it('laat de korting leeg zonder groothandel', () => {
    const { library, captured } = fakeExcel()
    buildWorkbook(library, [customer({ wholesaleDiscount: 5 })])
    expect(captured.rows[0]).toMatchObject({ discount: '', login: 'nee' })
  })
})

describe('exportCustomersToExcel', () => {
  it('meldt een fout als de Excel-bibliotheek ontbreekt', async () => {
    vi.mocked(listCustomers).mockResolvedValue({ items: [], total: 0 })
    await expect(exportCustomersToExcel('', '')).rejects.toThrow('Excel-export niet beschikbaar.')
  })
  it('downloadt klanten.xlsx met de bibliotheek van de schil', async () => {
    vi.mocked(listCustomers).mockResolvedValue({ items: [customer()], total: 1 })
    const { library } = fakeExcel()
    ;(window as unknown as Record<string, unknown>).AquatechCommon = { excel: async () => library }
    const created: string[] = []
    URL.createObjectURL = vi.fn(() => 'blob:test')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { created.push(this.download) })
    await exportCustomersToExcel('', '')
    expect(created).toEqual(['klanten.xlsx'])
  })
})
