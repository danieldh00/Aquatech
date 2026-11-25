// Tests van de klantkaart: kaarten per recht, opslaan, goedkeuren, uitnodigen, wissen (AVG) en documentlijsten.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { mountWithRouter } from '../helpers/mount'
import { makeCustomer, makeDetail } from './fixtures'
import { ApiError } from '@/shared/api'

vi.mock('@/modules/klanten/customers-api', () => ({
  getCustomer: vi.fn(), patchCustomer: vi.fn(), inviteCustomer: vi.fn(), anonymizePreview: vi.fn(), anonymizeCustomer: vi.fn(),
}))
import { anonymizeCustomer, anonymizePreview, getCustomer, inviteCustomer, patchCustomer } from '@/modules/klanten/customers-api'
import CustomerDetail from '@/modules/klanten/CustomerDetail.vue'
import ToastHost from '@/shared/ToastHost.vue'

beforeEach(() => {
  vi.mocked(getCustomer).mockResolvedValue(makeDetail())
  vi.mocked(anonymizePreview).mockResolvedValue({})
})
afterEach(() => { vi.clearAllMocks() })

/**
 * Monteert de klantkaart.
 * @returns De wrapper en router.
 */
function mountDetail() {
  return mountWithRouter(CustomerDetail, { props: { id: 'c1' } })
}

describe('CustomerDetail laden', () => {
  it('toont de naam, pillen, het klantdossier en de vier kaarten', async () => {
    const { wrapper } = await mountDetail()
    expect(getCustomer).toHaveBeenCalledWith('c1')
    expect(wrapper.find('h1').text()).toBe('Jan de Vries')
    expect(wrapper.find('.klant-title a.btn').attributes('href')).toBe('../klantdossier/?klant=a-c1')
    expect(wrapper.findAll('.card-grid > *')).toHaveLength(4)
    expect(document.title).toBe('Jan de Vries – Klanten – AquaTech Hub')
  })

  it('toont een melding met een link terug als de klant niet bestaat', async () => {
    vi.mocked(getCustomer).mockRejectedValue(new ApiError('Klant niet gevonden.', 404))
    const { wrapper } = await mountDetail()
    expect(wrapper.find('.notice').text()).toBe('Klant niet gevonden. Terug naar de klanten')
    expect(wrapper.find('.notice a').attributes('href')).toBe('./')
  })

  it('verbergt de privacykaart en het dossier zonder recht, en toont de groep alleen-lezen', async () => {
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({ mayPrice: false, mayDossier: false, customer: makeCustomer({ customerGroup: 'zakelijk', wholesale: true, wholesaleDiscount: 10 }) }))
    const { wrapper } = await mountDetail()
    expect(wrapper.find('#c-privacy').exists()).toBe(false)
    expect(wrapper.find('.klant-title a.btn').exists()).toBe(false)
    expect(wrapper.find('#c-business select').exists()).toBe(false)
    expect(wrapper.find('#c-business').text()).toContain('Alleen een beheerder wijzigt de klantgroep.')
    expect(wrapper.find('#c-business').text()).toContain('Ja, vaste korting 10%')
  })

  it('toont documentlijsten met directe links, en niets bij een lijst waar het recht voor ontbreekt', async () => {
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({
      quotes: [{ id: 'q1', number: 'O2026-0001', title: 'Tuin', status: 'akkoord', total: 1234.5 }],
      workOrders: [{ id: 'w1', number: 'WO-2026-0001', title: 'Aanleg', status: 'bezig', plannedDate: '2026-10-22' }],
      invoices: null,
    }))
    const { wrapper } = await mountDetail()
    const cards = wrapper.findAll('.docs-grid .card')
    expect(cards).toHaveLength(2)
    expect(cards[0].find('h3').text()).toBe('Offertes (1)')
    expect(cards[0].find('a').attributes('href')).toBe('../offertes/?id=q1')
    expect(cards[0].text()).toContain('Akkoord')
    expect(cards[0].find('tbody .num').text().replace(/\s/g, ' ')).toBe('€ 1.234,50')
    expect(cards[1].find('a').attributes('href')).toBe('../werkorders/?id=w1')
    expect(cards[1].text()).toContain('22-10-2026')
  })

  it('toont de lege tekst bij een lijst zonder documenten', async () => {
    const { wrapper } = await mountDetail()
    expect(wrapper.findAll('.docs-grid .empty').map((element) => element.text())).toEqual([
      'Nog geen offertes voor deze klant.', 'Nog geen werkorders voor deze klant.', 'Nog geen facturen voor deze klant.'])
  })

  it('noemt een concept- en een creditfactuur', async () => {
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({ invoices: [
      { id: 'i1', number: '', status: 'concept', kind: 'invoice', invoiceDate: '2026-01-02', total: 10 },
      { id: 'i2', number: 'F2026-0002', status: 'definitief', kind: 'credit', invoiceDate: '2026-01-03', total: -5 }] }))
    const { wrapper } = await mountDetail()
    const rows = wrapper.findAll('.docs-grid tbody tr')
    expect(rows[0].find('a').text()).toBe('Concept')
    expect(rows[1].text()).toContain('Definitief (credit)')
  })
})

describe('CustomerDetail opslaan', () => {
  it('slaat de gegevens op, toont een melding en vult het formulier met het antwoord', async () => {
    vi.mocked(patchCustomer).mockResolvedValue({ customer: makeCustomer({ phone: '0699999999', paymentDays: 30 }) })
    const { wrapper } = await mountDetail()
    const toast = mount(ToastHost, { attachTo: document.body })
    await wrapper.find('#c-contact [name=phone]').setValue('0699999999')
    await wrapper.find('#c-contact [name=paymentDays]').setValue('30')
    await wrapper.find('#c-contact').trigger('submit')
    await flushPromises()
    expect(patchCustomer).toHaveBeenCalledWith('c1', expect.objectContaining({ displayName: 'Jan de Vries', phone: '0699999999', paymentDays: '30', documentLanguage: 'nl', remindersOff: false, address: 'Kerkstraat 1\n1234 AB Plaats' }))
    expect(toast.text()).toBe('Gegevens opgeslagen')
    expect((wrapper.find('#c-contact [name=paymentDays]').element as HTMLInputElement).value).toBe('30')
    toast.unmount()
  })

  it('toont de foutmelding van de server op de kaart', async () => {
    vi.mocked(patchCustomer).mockRejectedValue(new ApiError('E-mailadres is al in gebruik.', 409, 'email'))
    const { wrapper } = await mountDetail()
    await wrapper.find('#c-contact').trigger('submit')
    await flushPromises()
    expect(wrapper.find('#c-contact-err').text()).toBe('E-mailadres is al in gebruik.')
  })

  it('toont de hint met de standaard betaaltermijn', async () => {
    const { wrapper } = await mountDetail()
    expect(wrapper.find('#c-contact').text()).toContain('Leeg: de standaard van 14 dagen.')
  })

  it('stuurt bij een particulier alleen de klantgroep, bij zakelijk ook bedrijf en groothandel', async () => {
    vi.mocked(patchCustomer).mockResolvedValue({ customer: makeCustomer() })
    const { wrapper } = await mountDetail()
    await wrapper.find('#c-business').trigger('submit')
    await flushPromises()
    expect(patchCustomer).toHaveBeenLastCalledWith('c1', { customerGroup: '' })
    await wrapper.find('#c-business [name=customerGroup]').setValue('zakelijk')
    await wrapper.find('#c-business [name=companyName]').setValue('Jan BV')
    await wrapper.find('#c-business [name=kvkNumber]').setValue('12345678')
    await wrapper.find('#c-business [name=wholesale]').setValue(true)
    await wrapper.find('#c-business [name=wholesaleDiscount]').setValue('12.5')
    await wrapper.find('#c-business').trigger('submit')
    await flushPromises()
    expect(patchCustomer).toHaveBeenLastCalledWith('c1', { customerGroup: 'zakelijk', companyName: 'Jan BV', kvkNumber: '12345678', vatNumber: '', wholesale: true, wholesaleDiscount: 12.5 })
  })

  it('stuurt zonder groothandelsvinkje geen korting mee', async () => {
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({ customer: makeCustomer({ customerGroup: 'zakelijk', companyName: 'X BV', wholesale: true, wholesaleDiscount: 5 }) }))
    vi.mocked(patchCustomer).mockResolvedValue({ customer: makeCustomer({ customerGroup: 'zakelijk' }) })
    const { wrapper } = await mountDetail()
    await wrapper.find('#c-business [name=wholesale]').setValue(false)
    await wrapper.find('#c-business').trigger('submit')
    await flushPromises()
    expect(patchCustomer).toHaveBeenCalledWith('c1', expect.objectContaining({ wholesale: false }))
    expect(vi.mocked(patchCustomer).mock.calls[0][1]).not.toHaveProperty('wholesaleDiscount')
  })

  it('stuurt zonder recht op prijzen niets als de klant geen bedrijf is', async () => {
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({ mayPrice: false }))
    const { wrapper } = await mountDetail()
    await wrapper.find('#c-business').trigger('submit')
    await flushPromises()
    expect(patchCustomer).not.toHaveBeenCalled()
  })

  it('verbergt de bedrijfsvelden voor een particulier en toont ze na de keuze Zakelijk', async () => {
    const { wrapper } = await mountDetail()
    const hidden = () => wrapper.findAll('#c-business [data-business]').map((element) => (element.element as HTMLElement).hidden)
    expect(hidden().every(Boolean)).toBe(true)
    await wrapper.find('#c-business [name=customerGroup]').setValue('zakelijk')
    expect(hidden().some(Boolean)).toBe(false)
  })

  it('zet het adresveld op handmatig zodra het btw-nummer van een ander land is', async () => {
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({ customer: makeCustomer({ customerGroup: 'zakelijk' }) }))
    const { wrapper } = await mountDetail()
    const address = wrapper.find('#c-contact textarea').element as HTMLTextAreaElement
    expect(address.dataset.addressManual).toBeUndefined()
    await wrapper.find('#c-business [name=vatNumber]').setValue('DE123456789')
    expect(address.dataset.addressManual).toBe('1')
  })
})

describe('CustomerDetail aanvraag zakelijk', () => {
  beforeEach(() => {
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({ customer: makeCustomer({ businessRequest: 'aangevraagd' }) }))
    vi.mocked(patchCustomer).mockResolvedValue({ customer: makeCustomer() })
  })
  it('keurt de aanvraag goed', async () => {
    const { wrapper } = await mountDetail()
    await wrapper.find('[data-approve]').trigger('click')
    expect(patchCustomer).toHaveBeenCalledWith('c1', { customerGroup: 'zakelijk' })
  })
  it('wijst de aanvraag af', async () => {
    const { wrapper } = await mountDetail()
    await wrapper.find('[data-reject]').trigger('click')
    expect(patchCustomer).toHaveBeenCalledWith('c1', { customerGroup: '' })
  })
  it('toont zonder recht op prijzen wel de aanvraag maar geen knoppen', async () => {
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({ mayPrice: false, customer: makeCustomer({ businessRequest: 'aangevraagd' }) }))
    const { wrapper } = await mountDetail()
    expect(wrapper.find('.request-banner').exists()).toBe(true)
    expect(wrapper.find('[data-approve]').exists()).toBe(false)
  })
})

describe('CustomerDetail toegang', () => {
  it('stuurt een uitnodiging', async () => {
    vi.mocked(inviteCustomer).mockResolvedValue()
    const { wrapper } = await mountDetail()
    const toast = mount(ToastHost, { attachTo: document.body })
    await wrapper.find('[data-invite]').trigger('click')
    await flushPromises()
    expect(inviteCustomer).toHaveBeenCalledWith('c1')
    expect(toast.text()).toBe('Uitnodiging verstuurd')
    toast.unmount()
  })
  it('zet de knop uit met uitleg als uitnodigen niet kan, en bij een uitgeschakelde klant', async () => {
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({ inviteProblem: 'Stel eerst een webadres in.' }))
    const first = await mountDetail()
    expect((first.wrapper.find('[data-invite]').element as HTMLButtonElement).disabled).toBe(true)
    expect(first.wrapper.find('.card:has([data-invite])').text()).toContain('Stel eerst een webadres in.')
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({ customer: makeCustomer({ disabled: true }) }))
    const second = await mountDetail()
    expect((second.wrapper.find('[data-invite]').element as HTMLButtonElement).disabled).toBe(true)
    expect(second.wrapper.text()).toContain('Uitgeschakeld')
  })
  it('toont de fout van de server bij het uitnodigen', async () => {
    vi.mocked(inviteCustomer).mockRejectedValue(new ApiError('Mail mislukt.', 502))
    const { wrapper } = await mountDetail()
    await wrapper.find('[data-invite]').trigger('click')
    await flushPromises()
    expect(wrapper.find('#c-access-err').text()).toBe('Mail mislukt.')
  })
  it('zegt of de klant al kan inloggen', async () => {
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({ customer: makeCustomer({ hasLogin: true, emailVerified: true }) }))
    const { wrapper } = await mountDetail()
    expect(wrapper.find('.fact-list').text()).toContain('Ja (e-mailadres bevestigd)')
  })
})

describe('CustomerDetail privacy (AVG)', () => {
  it('zet de wisknop pas aan als de naam klopt en een wachtwoord is ingevuld', async () => {
    const { wrapper } = await mountDetail()
    const button = () => (wrapper.find('[data-erase]').element as HTMLButtonElement).disabled
    expect(button()).toBe(true)
    await wrapper.find('#c-erase-confirm').setValue('Jan de Vries')
    expect(button()).toBe(true)
    await wrapper.find('#c-erase-password').setValue('geheim')
    expect(button()).toBe(false)
    await wrapper.find('#c-erase-confirm').setValue('Jan')
    expect(button()).toBe(true)
  })
  it('toont de waarschuwing over zwakke koppelingen met werkorders', async () => {
    vi.mocked(anonymizePreview).mockResolvedValue({ weakLinks: { count: 3, numbers: ['WO-1', 'WO-2'] } })
    const { wrapper } = await mountDetail()
    expect(wrapper.find('#c-erase-weak').text()).toContain('3 werkorder(s)')
    expect(wrapper.find('#c-erase-weak').text()).toContain('WO-1, WO-2, …')
  })
  it('wist met de bevestiging en laadt de kaart daarna opnieuw', async () => {
    vi.mocked(anonymizeCustomer).mockResolvedValue()
    const { wrapper } = await mountDetail()
    await wrapper.find('#c-erase-confirm').setValue(' Jan de Vries ')
    await wrapper.find('#c-erase-password').setValue('geheim')
    vi.mocked(getCustomer).mockClear()
    await wrapper.find('[data-erase]').trigger('click')
    await flushPromises()
    expect(anonymizeCustomer).toHaveBeenCalledWith('c1', { confirm: 'Jan de Vries', password: 'geheim', totp: '' })
    expect(getCustomer).toHaveBeenCalledTimes(1)
  })
  it('vraagt om de authenticatorcode als de server dat wil', async () => {
    vi.mocked(anonymizeCustomer).mockRejectedValue(new ApiError('Voer je code in.', 401, null, 'totp_required'))
    const { wrapper } = await mountDetail()
    expect((wrapper.find('#c-erase-totp-row').element as HTMLElement).hidden).toBe(true)
    await wrapper.find('#c-erase-confirm').setValue('Jan de Vries')
    await wrapper.find('#c-erase-password').setValue('geheim')
    await wrapper.find('[data-erase]').trigger('click')
    await flushPromises()
    expect((wrapper.find('#c-erase-totp-row').element as HTMLElement).hidden).toBe(false)
    expect(wrapper.find('#c-privacy-err').text()).toBe('Voer je code in.')
  })
  it('toont bij een al gewiste klant geen wisformulier', async () => {
    vi.mocked(getCustomer).mockResolvedValue(makeDetail({ customer: makeCustomer({ username: 'verwijderd-abc' }) }))
    const { wrapper } = await mountDetail()
    expect(wrapper.find('[data-erase]').exists()).toBe(false)
    expect(wrapper.find('#c-privacy').text()).toContain('Deze klant is gewist.')
    expect(anonymizePreview).not.toHaveBeenCalled()
  })
  it('wijst de inzage-download naar de Excel van de server', async () => {
    const { wrapper } = await mountDetail()
    expect(wrapper.find('#c-privacy a.btn').attributes('href')).toBe('../api/customers/c1/privacy-export')
  })
})
