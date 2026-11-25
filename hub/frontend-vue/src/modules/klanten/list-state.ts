// Stand van de klantenlijst (zoekwoord, filter, pagina), bewaard buiten het component zodat die gelijk blijft als je
// een klant opent en terugkeert (de oude pagina hield de lijst verborgen in de DOM; dit is hetzelfde gedrag).
import { reactive } from 'vue'
import type { Customer, GroupFilter } from './types'

/** De stand van de lijst. */
export interface ListState {
  search: string
  group: GroupFilter
  offset: number
  items: Customer[]
  total: number
  /** Foutmelding van het laatste laden (leeg = goed). */
  error: string
}

export const listState: ListState = reactive({ search: '', group: '', offset: 0, items: [], total: 0, error: '' })
