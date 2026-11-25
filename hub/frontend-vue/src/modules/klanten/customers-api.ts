// Aanroepen van de klanten-API, zodat de componenten zelf geen adressen hoeven te kennen.
import { api } from '@/shared/api'
import type { AnonymizePreview, CreatedCustomer, Customer, CustomerDetail, CustomerPage, GroupFilter } from './types'

/** Velden die bij een nieuwe klant meegaan. */
export interface NewCustomerBody {
  displayName: string
  email: string
  phone: string
  address: string
  customerGroup: '' | 'zakelijk'
  invite: boolean
  companyName?: string
  kvkNumber?: string
  vatNumber?: string
}

/**
 * Haalt een pagina klanten op.
 * @param params Zoekwoord, groepsfilter en paginagrenzen.
 * @returns De klanten en het totaal.
 */
export function listCustomers(params: { search: string; group: GroupFilter; limit: number; offset: number }): Promise<CustomerPage> {
  const query = new URLSearchParams({ limit: String(params.limit), offset: String(params.offset) })
  if (params.search) query.set('q', params.search)
  if (params.group) query.set('group', params.group)
  return api<CustomerPage>(`customers?${query}`)
}

/**
 * Haalt de klantkaart op.
 * @param id Id van de klant.
 * @returns De klant met zijn documenten en de rechten van de aanvrager.
 */
export function getCustomer(id: string): Promise<CustomerDetail> {
  return api<CustomerDetail>(`customers/${encodeURIComponent(id)}`)
}

/**
 * Maakt een nieuwe klant.
 * @param body De gegevens.
 * @returns De klant en, bij een uitnodiging, hoe het versturen ging.
 */
export function createCustomer(body: NewCustomerBody): Promise<CreatedCustomer> {
  return api<CreatedCustomer>('customers', { method: 'POST', body })
}

/**
 * Wijzigt velden van een klant.
 * @param id Id van de klant.
 * @param body De te wijzigen velden.
 * @returns De bijgewerkte klant.
 */
export function patchCustomer(id: string, body: Record<string, unknown>): Promise<{ customer: Customer }> {
  return api<{ customer: Customer }>(`customers/${encodeURIComponent(id)}`, { method: 'PATCH', body })
}

/**
 * Stuurt de uitnodiging om een wachtwoord te kiezen.
 * @param id Id van de klant.
 * @returns Niets.
 */
export async function inviteCustomer(id: string): Promise<void> {
  await api(`customers/${encodeURIComponent(id)}/invite`, { method: 'POST', body: {} })
}

/**
 * Vraagt wat er bij het wissen van de persoonsgegevens meegaat.
 * @param id Id van de klant.
 * @returns Waarschuwing over zwakke koppelingen met werkorders.
 */
export function anonymizePreview(id: string): Promise<AnonymizePreview> {
  return api<AnonymizePreview>(`customers/${encodeURIComponent(id)}/anonymize-preview`)
}

/**
 * Wist de persoonsgegevens van een klant (AVG).
 * @param id Id van de klant.
 * @param body Bevestigde naam, wachtwoord en eventueel de authenticatorcode.
 * @returns Niets.
 */
export async function anonymizeCustomer(id: string, body: { confirm: string; password: string; totp: string }): Promise<void> {
  await api(`customers/${encodeURIComponent(id)}/anonymize`, { method: 'POST', body })
}
