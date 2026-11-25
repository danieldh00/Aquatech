// Tests van het formulier voor een nieuwe klant: velden per soort, versturen, meldingen en foutafhandeling.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountWithRouter } from '../helpers/mount'
import { makeCustomer } from './fixtures'
import { ApiError } from '@/shared/api'

vi.mock('@/modules/klanten/customers-api', () => ({ createCustomer: vi.fn() }))
import { createCustomer } from '@/modules/klanten/customers-api'
import CustomerNew from '@/modules/klanten/CustomerNew.vue'
import ToastHost from '@/shared/ToastHost.vue'
import { mount } from '@vue/test-utils'

/**
 * Zet de ingelogde gebruiker van de schil.
 * @param rights Rechten van de gebruiker (null = ophalen mislukt).
 * @returns Niets.
 */
function setMe(rights: string[] | null): void {
  ;(window as unknown as Record<string, unknown>).AquatechCommon = { getJson: rights ? async () => ({ rights }) : async () => { throw new Error('fout') }, statusMessage: () => 'x' }
}

beforeEach(() => { setMe(['beheer']) })
afterEach(() => { vi.clearAllMocks(); delete (window as unknown as Record<string, unknown>).AquatechCommon })

describe('CustomerNew', () => {
  it('verbergt bedrijfsvelden bij een particulier en toont ze bij zakelijk', async () => {
    const { wrapper } = await mountWithRouter(CustomerNew)
    const business = () => wrapper.findAll('[data-business]').map((element) => (element.element as HTMLElement).hidden)
    expect(business()).toEqual([true, true, true])
    await wrapper.find('[name=customerGroup]').setValue('zakelijk')
    expect(business()).toEqual([false, false, false])
  })

  it('biedt zakelijk alleen aan een beheerder aan', async () => {
    setMe(['klanten'])
    const { wrapper } = await mountWithRouter(CustomerNew)
    expect(wrapper.findAll('[name=customerGroup] option').map((option) => option.attributes('value'))).toEqual([''])
  })

  it('houdt de keuze staan als het ophalen van de rechten mislukt (de server weigert wat niet mag)', async () => {
    setMe(null)
    const { wrapper } = await mountWithRouter(CustomerNew)
    expect(wrapper.findAll('[name=customerGroup] option')).toHaveLength(2)
  })

  it('stuurt een particulier zonder bedrijfsgegevens en opent daarna de klantkaart', async () => {
    vi.mocked(createCustomer).mockResolvedValue({ customer: makeCustomer({ id: 'nieuw1' }) })
    const { wrapper, router } = await mountWithRouter(CustomerNew)
    await wrapper.find('[name=displayName]').setValue('Piet')
    await wrapper.find('[name=email]').setValue('piet@example.nl')
    await wrapper.find('[name=companyName]').setValue('Niet meesturen')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(createCustomer).toHaveBeenCalledWith({ displayName: 'Piet', email: 'piet@example.nl', phone: '', address: '', customerGroup: '', invite: false })
    expect(router.currentRoute.value.query.id).toBe('nieuw1')
  })

  it('stuurt bij zakelijk de bedrijfsgegevens en de uitnodiging mee', async () => {
    vi.mocked(createCustomer).mockResolvedValue({ customer: makeCustomer({ id: 'z1' }), invite: { sent: true } })
    const { wrapper } = await mountWithRouter(CustomerNew)
    await wrapper.find('[name=customerGroup]').setValue('zakelijk')
    await wrapper.find('[name=displayName]').setValue('Els')
    await wrapper.find('[name=companyName]').setValue('Els BV')
    await wrapper.find('[name=kvkNumber]').setValue('12345678')
    await wrapper.find('[name=vatNumber]').setValue('NL123456789B01')
    await wrapper.find('[name=invite]').setValue(true)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(createCustomer).toHaveBeenCalledWith(expect.objectContaining({ customerGroup: 'zakelijk', companyName: 'Els BV', kvkNumber: '12345678', vatNumber: 'NL123456789B01', invite: true }))
  })

  it('toont de melding van de server en zet de focus op het veld', async () => {
    vi.mocked(createCustomer).mockRejectedValue(new ApiError('Naam ontbreekt', 400, 'displayName'))
    const { wrapper } = await mountWithRouter(CustomerNew)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('#n-err').text()).toBe('Naam ontbreekt')
    expect(document.activeElement).toBe(wrapper.find('[name=displayName]').element)
  })

  it('meldt dat de uitnodiging niet verstuurd is', async () => {
    vi.mocked(createCustomer).mockResolvedValue({ customer: makeCustomer(), invite: { sent: false, problem: 'Geen mailserver' } })
    const { router } = await mountWithRouter(CustomerNew)
    const toast = mount(ToastHost, { attachTo: document.body })
    const form = document.querySelector('form') as HTMLFormElement
    form.dispatchEvent(new Event('submit', { cancelable: true }))
    await flushPromises()
    expect(toast.text()).toContain('Klant opgeslagen. Uitnodiging niet verstuurd: Geen mailserver')
    expect(toast.classes()).toContain('err')
    expect(router.currentRoute.value.query.id).toBe('c1')
    toast.unmount()
  })

  it('keert met Annuleren en de terugknop terug naar de lijst', async () => {
    const { wrapper, router } = await mountWithRouter(CustomerNew, { url: '/?nieuw' })
    await wrapper.find('#n-cancel').trigger('click')
    await flushPromises()
    expect('nieuw' in router.currentRoute.value.query).toBe(false)
  })
})
