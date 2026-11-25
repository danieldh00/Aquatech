// Gedeelde testgegevens van de klantenmodule.
import type { Customer, CustomerDetail } from '@/modules/klanten/types'

/**
 * Maakt een klant met de gegeven afwijkingen.
 * @param overrides Velden die afwijken.
 * @returns Een klant.
 */
export function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'c1', displayName: 'Jan de Vries', username: 'jan', companyName: '', address: 'Kerkstraat 1\n1234 AB Plaats', email: 'jan@example.nl', phone: '0612345678',
    customerGroup: '', wholesale: false, wholesaleDiscount: 0, businessRequest: '', hasLogin: false, disabled: false, kvkNumber: '', vatNumber: '', paymentDays: null,
    documentLanguage: 'nl', remindersOff: false, ...overrides,
  }
}

/**
 * Maakt het antwoord van een klantkaart met de gegeven afwijkingen.
 * @param overrides Velden die afwijken.
 * @returns Het antwoord van de server.
 */
export function makeDetail(overrides: Partial<CustomerDetail> = {}): CustomerDetail {
  return {
    customer: makeCustomer(), quotes: [], workOrders: [], invoices: [], mayPrice: true, mayDossier: true, dossierKey: 'a-c1', inviteProblem: '', defaultPaymentDays: 14, ...overrides,
  }
}
