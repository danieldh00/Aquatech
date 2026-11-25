// Types van de klanten-API (`/api/customers`), zoals de server ze teruggeeft.

/** Een klant in de lijst en op de klantkaart. */
export interface Customer {
  id: string
  displayName: string
  username: string
  companyName: string
  address: string
  email: string
  phone: string
  customerGroup: '' | 'zakelijk'
  wholesale: boolean
  wholesaleDiscount: number
  businessRequest: string
  hasLogin: boolean
  disabled: boolean
  emailVerified?: boolean
  kvkNumber: string
  vatNumber: string
  paymentDays: number | null
  documentLanguage: string
  remindersOff: boolean
}

/** Antwoord van `GET customers?…`. */
export interface CustomerPage {
  items: Customer[]
  total: number
}

/** Een offerte in de klantkaart. */
export interface QuoteRow { id: string; number: string; title: string; status: string; total: number }
/** Een werkorder in de klantkaart. */
export interface WorkOrderRow { id: string; number: string; title: string; status: string; plannedDate: string }
/** Een factuur in de klantkaart. */
export interface InvoiceRow { id: string; number: string; status: string; kind: string; invoiceDate: string; total: number }

/** Antwoord van `GET customers/:id`; een lijst die `null` is, mag de aanvrager niet zien. */
export interface CustomerDetail {
  customer: Customer
  quotes: QuoteRow[] | null
  workOrders: WorkOrderRow[] | null
  invoices: InvoiceRow[] | null
  mayPrice: boolean
  mayDossier: boolean
  dossierKey: string
  inviteProblem: string
  defaultPaymentDays: number
}

/** Antwoord van `POST customers`. */
export interface CreatedCustomer {
  customer: Customer
  invite?: { sent: boolean; problem?: string }
}

/** Antwoord van `GET customers/:id/anonymize-preview`. */
export interface AnonymizePreview {
  weakLinks?: { count: number; numbers: string[] }
}

/** Groepsfilter van de lijst. */
export type GroupFilter = '' | 'particulier' | 'zakelijk' | 'groothandel' | 'aanvraag'
