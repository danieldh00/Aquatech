// Tests van de hoofdcomponent: de weergave volgt uit het adres, zoals in de oude pagina.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountWithRouter } from '../helpers/mount'
import { makeDetail } from './fixtures'
import { listState } from '@/modules/klanten/list-state'

vi.mock('@/modules/klanten/customers-api', () => ({ listCustomers: vi.fn(), getCustomer: vi.fn(), anonymizePreview: vi.fn() }))
import { anonymizePreview, getCustomer, listCustomers } from '@/modules/klanten/customers-api'
import KlantenApp from '@/modules/klanten/KlantenApp.vue'

beforeEach(() => {
  Object.assign(listState, { search: '', group: '', offset: 0, items: [], total: 0, error: '' })
  vi.mocked(listCustomers).mockResolvedValue({ items: [], total: 0 })
  vi.mocked(getCustomer).mockResolvedValue(makeDetail())
  vi.mocked(anonymizePreview).mockResolvedValue({})
})
afterEach(() => { vi.clearAllMocks(); delete (window as unknown as Record<string, unknown>).AquatechCommon })

describe('KlantenApp', () => {
  it('toont de lijst op het gewone adres en zet de titel', async () => {
    const { wrapper } = await mountWithRouter(KlantenApp)
    expect(wrapper.find('#list-view').exists()).toBe(true)
    expect(document.title).toBe('Klanten – AquaTech Hub')
  })
  it('toont het formulier bij ?nieuw', async () => {
    const { wrapper } = await mountWithRouter(KlantenApp, { url: '/?nieuw' })
    expect(wrapper.find('#new-view').exists()).toBe(true)
    expect(wrapper.find('#list-view').exists()).toBe(false)
  })
  it('toont de klantkaart bij ?id=… en wisselt mee met de terugknop', async () => {
    const { wrapper, router } = await mountWithRouter(KlantenApp, { url: '/?id=c1' })
    expect(wrapper.find('#detail-view').exists()).toBe(true)
    await router.push('/')
    expect(wrapper.find('#list-view').exists()).toBe(true)
  })
  it('laadt de weergave opnieuw na terugkeer uit de browsercache (onReturn)', async () => {
    let onReturn: () => void = () => {}
    ;(window as unknown as Record<string, unknown>).AquatechCommon = { onReturn: (callback: () => void) => { onReturn = callback } }
    await mountWithRouter(KlantenApp)
    expect(listCustomers).toHaveBeenCalledTimes(1)
    onReturn()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listCustomers).toHaveBeenCalledTimes(2)
  })
  it('bevat een melding-element voor de toasts', async () => {
    const { wrapper } = await mountWithRouter(KlantenApp)
    expect(wrapper.find('#toast').exists()).toBe(true)
  })
})
