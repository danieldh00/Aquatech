// Vaste teksten en kleine hulpfuncties van de klantenmodule (statusnamen, pillen, btw-landcontrole).
import type { Customer } from './types'

/** Aantal klanten per pagina in de lijst. */
export const PAGE_SIZE = 50

/** Leesbare namen van de offertestatussen. */
export const QUOTE_STATUS: Record<string, string> = { concept: 'Concept', verzonden: 'Verzonden', akkoord: 'Akkoord', afgewezen: 'Afgewezen', verlopen: 'Verlopen', omgezet: 'Omgezet' }
/** Leesbare namen van de werkorderstatussen. */
export const WORK_ORDER_STATUS: Record<string, string> = { open: 'Open', gepland: 'Gepland', bezig: 'Bezig', gereed: 'Gereed', geannuleerd: 'Geannuleerd' }
/** Leesbare namen van de factuurstatussen. */
export const INVOICE_STATUS: Record<string, string> = { concept: 'Concept', definitief: 'Definitief', betaald: 'Betaald' }

/** Eén pil naast een klantnaam. */
export interface Pill {
  key: string
  label: string
  className: string
}

/**
 * De pillen bij een klant: groep, groothandel, open aanvraag, inlog en uitgeschakeld.
 * @param customer De klant.
 * @returns De pillen in vaste volgorde.
 */
export function pillsOf(customer: Pick<Customer, 'customerGroup' | 'wholesale' | 'businessRequest' | 'hasLogin' | 'disabled'>): Pill[] {
  const pills: Pill[] = [customer.customerGroup === 'zakelijk' ? { key: 'groep', label: 'Zakelijk', className: 'pill zakelijk' } : { key: 'groep', label: 'Particulier', className: 'pill' }]
  if (customer.wholesale) pills.push({ key: 'groothandel', label: 'Groothandel', className: 'pill groothandel' })
  if (customer.businessRequest === 'aangevraagd') pills.push({ key: 'aanvraag', label: 'Aanvraag zakelijk', className: 'pill aanvraag' })
  if (customer.hasLogin) pills.push({ key: 'inlog', label: 'Inlog', className: 'pill inlog' })
  if (customer.disabled) pills.push({ key: 'uit', label: 'Uitgeschakeld', className: 'pill' })
  return pills
}

/**
 * Of een btw-nummer bij een ander land dan Nederland hoort (het adres ligt dan buiten PDOK en wordt vrij getypt;
 * de server controleert het nummer bij VIES).
 * @param vatNumber Het ingevulde btw-nummer.
 * @returns true bij een nummer dat met twee letters begint die niet NL zijn.
 */
export function isForeignVat(vatNumber: string): boolean {
  const number = String(vatNumber || '').replace(/[\s.-]/g, '').toUpperCase()
  return /^[A-Z]{2}/.test(number) && !number.startsWith('NL')
}

/**
 * Een adres op één regel (nieuwe regels worden komma's).
 * @param address Het adres, mogelijk met nieuwe regels.
 * @returns Het adres op één regel.
 */
export function addressOneLine(address: string | null | undefined): string {
  return String(address || '').replace(/\n/g, ', ')
}
