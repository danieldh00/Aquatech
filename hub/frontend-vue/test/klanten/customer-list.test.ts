// Tests van de klantenlijst: laden, zoeken met pauze, filter, pagina's, klikken en foutmeldingen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountWithRouter } from '../helpers/mount'
import { makeCustomer } from './fixtures'
import { listState } from '@/modules/klanten/list-state'

vi.mock('@/modules/klanten/customers-api', () => ({ listCustomers: vi.fn() }))
import { listCustomers } from '@/modules/klanten/customers-api'
import CustomerList from '@/modules/klanten/CustomerList.vue'

beforeEach(() => {
  Object.assign(listState, { search: '', group: '', offset: 0, items: [], total: 0, error: '' })
  vi.mocked(listCustomers).mockResolvedValue({ items: [makeCustomer(), makeCustomer({ id: 'c2', displayName: 'Bedrijf BV', customerGroup: 'zakelijk', companyName: 'Bedrijf BV', wholesale: true, disabled: true })], total: 2 })
})
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers() })

describe('CustomerList', () => {
  it('laadt de eerste pagina en toont regels, pillen en telling', async () => {
    const { wrapper } = await mountWithRouter(CustomerList)
    expect(listCustomers).toHaveBeenCalledWith({ search: '', group: '', limit: 50, offset: 0 })
    const rows = wrapper.findAll('tbody tr.row-link')
    expect(rows).toHaveLength(2)
    expect(rows[0].find('a').attributes('href')).toBe('?id=c1')
    expect(rows[0].text()).toContain('Kerkstraat 1, 1234 AB Plaats')
    expect(rows[1].classes()).toContain('off')
    expect(rows[1].findAll('.pill').map((pill) => pill.text())).toEqual(['Zakelijk', 'Groothandel', 'Uitgeschakeld'])
    expect(wrapper.find('#k-count').text()).toBe('1–2 van 2 klanten')
    expect((wrapper.find('#k-prev').element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.find('#k-next').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('zoekt pas na een pauze van 300 ms en begint weer op pagina 1', async () => {
    vi.useFakeTimers()
    listState.offset = 50
    const { wrapper } = await mountWithRouter(CustomerList)
    vi.mocked(listCustomers).mockClear()
    const input = wrapper.find('#k-search')
    await input.setValue('ja')
    await input.setValue('jan')
    vi.advanceTimersByTime(299)
    expect(listCustomers).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    await flushPromises()
    expect(listCustomers).toHaveBeenCalledTimes(1)
    expect(listCustomers).toHaveBeenCalledWith({ search: 'jan', group: '', limit: 50, offset: 0 })
  })

  it('past het groepsfilter toe', async () => {
    const { wrapper } = await mountWithRouter(CustomerList)
    await wrapper.find('#k-group').setValue('groothandel')
    await flushPromises()
    expect(listCustomers).toHaveBeenLastCalledWith({ search: '', group: 'groothandel', limit: 50, offset: 0 })
  })

  it('bladert met Vorige en Volgende', async () => {
    vi.mocked(listCustomers).mockResolvedValue({ items: [makeCustomer()], total: 120 })
    const { wrapper } = await mountWithRouter(CustomerList)
    expect(wrapper.find('#k-count').text()).toBe('1–1 van 120 klanten')
    await wrapper.find('#k-next').trigger('click')
    await flushPromises()
    expect(listCustomers).toHaveBeenLastCalledWith({ search: '', group: '', limit: 50, offset: 50 })
    await wrapper.find('#k-prev').trigger('click')
    await flushPromises()
    expect(listCustomers).toHaveBeenLastCalledWith({ search: '', group: '', limit: 50, offset: 0 })
  })

  it('opent de klantkaart bij een klik op de regel, maar niet bij Ctrl-klik op de naam', async () => {
    const { wrapper, router } = await mountWithRouter(CustomerList)
    await wrapper.find('tbody tr.row-link td:nth-child(4)').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.query.id).toBe('c1')
    await router.push('/')
    await wrapper.find('tbody tr.row-link a').trigger('click', { ctrlKey: true })
    await flushPromises()
    expect(router.currentRoute.value.query.id).toBeUndefined()
  })

  it('opent het formulier met Nieuwe klant (adres ?nieuw)', async () => {
    const { wrapper, router } = await mountWithRouter(CustomerList)
    await wrapper.find('#k-new').trigger('click')
    await flushPromises()
    expect('nieuw' in router.currentRoute.value.query).toBe(true)
  })

  it('toont de lege tekst, met of zonder filter', async () => {
    vi.mocked(listCustomers).mockResolvedValue({ items: [], total: 0 })
    const { wrapper } = await mountWithRouter(CustomerList)
    expect(wrapper.find('td.empty').text()).toContain('Nog geen klanten')
    listState.search = 'xyz'
    listState.items = []
    await wrapper.find('#k-group').setValue('zakelijk')
    await flushPromises()
    expect(wrapper.find('td.empty').text()).toContain('Geen klanten gevonden')
  })

  it('toont een foutmelding als laden mislukt', async () => {
    vi.mocked(listCustomers).mockRejectedValue(new Error('Geen recht'))
    const { wrapper } = await mountWithRouter(CustomerList)
    expect(wrapper.find('td.empty').text()).toBe('Kan de klanten niet laden (Geen recht).')
  })

  it('laat een trage oude aanvraag een nieuwere niet overschrijven', async () => {
    let releaseOld: (value: { items: ReturnType<typeof makeCustomer>[]; total: number }) => void = () => {}
    vi.mocked(listCustomers).mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve }))
    const { wrapper } = await mountWithRouter(CustomerList)
    vi.mocked(listCustomers).mockResolvedValue({ items: [makeCustomer({ id: 'nieuw', displayName: 'Nieuw' })], total: 1 })
    await wrapper.find('#k-group').setValue('zakelijk')
    await flushPromises()
    releaseOld({ items: [makeCustomer({ id: 'oud', displayName: 'Oud' })], total: 1 })
    await flushPromises()
    expect(wrapper.find('tbody').text()).toContain('Nieuw')
    expect(wrapper.find('tbody').text()).not.toContain('Oud')
  })

  it('opent het importvenster van de schil met de juiste paden', async () => {
    const open = vi.fn()
    ;(window as unknown as Record<string, unknown>).AquatechExcelImport = { open }
    const { wrapper } = await mountWithRouter(CustomerList)
    await wrapper.find('#k-import').trigger('click')
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ fieldsPath: 'customers/import/fields', importPath: 'customers/import', templateName: 'klanten-importeren-voorbeeld.xlsx' }))
    delete (window as unknown as Record<string, unknown>).AquatechExcelImport
  })
})
