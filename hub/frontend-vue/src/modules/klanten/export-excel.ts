// Excel-export van de klantenlijst (alle klanten met het huidige zoekwoord en filter, nooit CSV).
import { shellWindow, type ExcelLibrary } from '@/shared/shell'
import { listCustomers } from './customers-api'
import { addressOneLine } from './labels'
import type { Customer, GroupFilter } from './types'

/** Aantal klanten per aanvraag bij het ophalen voor de export. */
const EXPORT_BATCH = 200

/**
 * Haalt alle klanten op die bij het zoekwoord en filter horen, in porties.
 * @param search Het zoekwoord (leeg = alle).
 * @param group Het groepsfilter (leeg = alle).
 * @returns Alle klanten.
 */
export async function fetchAllCustomers(search: string, group: GroupFilter): Promise<Customer[]> {
  const customers: Customer[] = []
  for (let offset = 0; ; offset += EXPORT_BATCH) {
    const out = await listCustomers({ search, group, limit: EXPORT_BATCH, offset })
    customers.push(...out.items)
    if (!out.items.length || customers.length >= out.total) break
  }
  return customers
}

/**
 * Naam van de groep van een klant zoals die in de Excel komt.
 * @param customer De klant.
 * @returns "Groothandel", "Zakelijk" of "Particulier".
 */
export function groupLabel(customer: Pick<Customer, 'wholesale' | 'customerGroup'>): string {
  if (customer.wholesale) return 'Groothandel'
  return customer.customerGroup === 'zakelijk' ? 'Zakelijk' : 'Particulier'
}

/**
 * Bouwt de Excel-werkmap met de klanten.
 * @param excel De ExcelJS-bibliotheek (van de schil).
 * @param customers De klanten.
 * @returns De werkmap, klaar om te schrijven.
 */
export function buildWorkbook(excel: ExcelLibrary, customers: Customer[]) {
  const workbook = new excel.Workbook()
  const sheet = workbook.addWorksheet('Klanten')
  sheet.columns = [
    { header: 'Naam', key: 'displayName', width: 28 }, { header: 'Bedrijf', key: 'companyName', width: 28 }, { header: 'KvK', key: 'kvkNumber', width: 12 },
    { header: 'Btw-nummer', key: 'vatNumber', width: 18 }, { header: 'Adres', key: 'address', width: 40 }, { header: 'E-mail', key: 'email', width: 30 },
    { header: 'Telefoon', key: 'phone', width: 16 }, { header: 'Groep', key: 'group', width: 14 }, { header: 'Groothandelskorting %', key: 'discount', width: 20 }, { header: 'Inlog', key: 'login', width: 8 },
  ]
  for (const customer of customers) {
    sheet.addRow({
      displayName: customer.displayName, companyName: customer.companyName, kvkNumber: customer.kvkNumber, vatNumber: customer.vatNumber,
      address: addressOneLine(customer.address), email: customer.email, phone: customer.phone, group: groupLabel(customer),
      discount: customer.wholesale ? customer.wholesaleDiscount : '', login: customer.hasLogin ? 'ja' : 'nee',
    })
  }
  sheet.getRow(1).font = { bold: true }
  sheet.views = [{ state: 'frozen', ySplit: 1 }]
  return workbook
}

/**
 * Exporteert alle klanten met het huidige zoekwoord en filter naar `klanten.xlsx` (download in de browser).
 * @param search Het zoekwoord.
 * @param group Het groepsfilter.
 * @returns Niets.
 * @throws {Error} Als de Excel-bibliotheek van de schil niet beschikbaar is.
 */
export async function exportCustomersToExcel(search: string, group: GroupFilter): Promise<void> {
  const customers = await fetchAllCustomers(search, group)
  const common = shellWindow().AquatechCommon
  const excel = (window as unknown as { ExcelJS?: ExcelLibrary }).ExcelJS || (common ? await common.excel() : null)
  if (!excel) throw new Error('Excel-export niet beschikbaar.')
  const buffer = await buildWorkbook(excel, customers).xlsx.writeBuffer()
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  link.download = 'klanten.xlsx'
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 10000)
}
