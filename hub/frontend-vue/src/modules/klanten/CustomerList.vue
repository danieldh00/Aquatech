<script setup lang="ts">
// De klantenlijst: zoeken, filteren, pagineren, Excel-export en -import, en een klik op een regel opent de klantkaart.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/shared/api'
import { shellWindow } from '@/shared/shell'
import { showToast } from '@/shared/toast'
import { listCustomers } from './customers-api'
import { exportCustomersToExcel } from './export-excel'
import { addressOneLine, PAGE_SIZE, pillsOf } from './labels'
import { listState } from './list-state'
import type { GroupFilter } from './types'

const router = useRouter()
const searchText = ref(listState.search)
const exporting = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined
let loadVersion = 0

const countText = computed(() => {
  const from = listState.total ? listState.offset + 1 : 0
  const to = Math.min(listState.total, listState.offset + listState.items.length)
  return `${from}–${to} van ${listState.total} klanten`
})
const emptyText = computed(() => (listState.search || listState.group
  ? 'Geen klanten gevonden met dit zoekwoord of filter.'
  : 'Nog geen klanten. Maak de eerste aan met Nieuwe klant.'))

/**
 * Haalt een pagina klanten op met het huidige zoekwoord en filter. Een oudere, trage aanvraag overschrijft nooit een nieuwere.
 * @returns Niets.
 */
async function loadList(): Promise<void> {
  const version = ++loadVersion
  try {
    const out = await listCustomers({ search: listState.search, group: listState.group, limit: PAGE_SIZE, offset: listState.offset })
    if (version !== loadVersion) return
    listState.items = out.items
    listState.total = out.total
    listState.error = ''
  } catch (error) {
    if (version !== loadVersion) return
    listState.error = (error as Error).message
  }
}

/**
 * Zoekt na een korte pauze in het typen (300 ms).
 * @param event Het typen in het zoekveld.
 * @returns Niets.
 */
function onSearchInput(event: Event): void {
  searchText.value = (event.target as HTMLInputElement).value
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    listState.search = searchText.value.trim()
    listState.offset = 0
    void loadList()
  }, 300)
}

/**
 * Past het groepsfilter toe en begint weer op de eerste pagina.
 * @param event De wijziging van de keuzelijst.
 * @returns Niets.
 */
function onGroupChange(event: Event): void {
  listState.group = (event.target as HTMLSelectElement).value as GroupFilter
  listState.offset = 0
  void loadList()
}

/**
 * Gaat naar de vorige of volgende pagina.
 * @param direction -1 voor vorige, 1 voor volgende.
 * @returns Niets.
 */
function turnPage(direction: -1 | 1): void {
  listState.offset = Math.max(0, listState.offset + direction * PAGE_SIZE)
  void loadList()
}

/**
 * Opent een klant met een klik op de regel; Ctrl/Cmd/Shift-klik op de naam opent een nieuw tabblad.
 * @param event De klik.
 * @param id Id van de klant.
 * @returns Niets.
 */
function openCustomer(event: MouseEvent, id: string): void {
  const onLink = (event.target as HTMLElement).closest('a[href^="?id="]')
  if (onLink && (event.ctrlKey || event.metaKey || event.shiftKey)) return
  event.preventDefault()
  void router.push({ path: '/', query: { id } })
}

/**
 * Exporteert alle klanten met het huidige zoekwoord en filter naar Excel.
 * @returns Niets.
 */
async function exportExcel(): Promise<void> {
  exporting.value = true
  try {
    await exportCustomersToExcel(listState.search, listState.group)
  } catch (error) {
    showToast((error as Error).message, true)
  } finally {
    exporting.value = false
  }
}

/**
 * Opent het importvenster van de schil: Excel kiezen, controleren en verwerken.
 * @returns Niets.
 */
function openImport(): void {
  const importer = shellWindow().AquatechExcelImport
  if (!importer) { showToast('Importeren is niet beschikbaar.', true); return }
  importer.open({
    title: 'Klanten importeren uit Excel', subject: 'De klanten', keyLabel: 'Naam', templateName: 'klanten-importeren-voorbeeld.xlsx', api,
    intro: 'Een klant wordt herkend op e-mailadres, anders op naam. Lege cellen laten een bestaande klant ongemoeid. Eerst volgt een controle; er wordt pas iets opgeslagen als je op Verwerken drukt.',
    fieldsPath: 'customers/import/fields', importPath: 'customers/import',
    onDone: () => { listState.offset = 0; void loadList() },
  })
}

onMounted(() => { void loadList() })
onBeforeUnmount(() => { clearTimeout(searchTimer) })
</script>

<template>
  <main id="list-view" class="dash wide">
    <section class="intro">
      <h1>Klanten</h1>
      <p class="muted">Je klanten op één plek. Een klant kan een inlog hebben (webshop en klantportaal) maar hoeft dat niet: dan staat hij hier gewoon als adresboek voor offertes, werkorders en facturen.</p>
    </section>
    <div class="klanten-filters">
      <input id="k-search" :value="searchText" type="search" placeholder="Zoek op naam, bedrijf, e-mail, telefoon of adres" aria-label="Zoeken" @input="onSearchInput">
      <select id="k-group" :value="listState.group" aria-label="Klantgroep" @change="onGroupChange">
        <option value="">Alle klanten</option>
        <option value="particulier">Particulier</option>
        <option value="zakelijk">Zakelijk</option>
        <option value="groothandel">Groothandel</option>
        <option value="aanvraag">Aanvraag zakelijk</option>
      </select>
      <button id="k-new" class="btn primary" type="button" @click="router.push({ path: '/', query: { nieuw: null } })">Nieuwe klant</button>
      <button id="k-export" class="btn" type="button" :disabled="exporting" @click="exportExcel">Exporteer naar Excel</button>
      <button id="k-import" class="btn" type="button" title="Klanten uit een Excel-bestand toevoegen of bijwerken, met eerst een controle" @click="openImport">Importeren uit Excel</button>
    </div>
    <div class="tablewrap">
      <table id="k-table" class="grid">
        <template v-if="listState.error">
          <tbody><tr><td class="empty">Kan de klanten niet laden ({{ listState.error }}).</td></tr></tbody>
        </template>
        <template v-else>
          <thead><tr><th>Naam</th><th>Bedrijf</th><th>Adres</th><th>E-mail</th><th>Telefoon</th><th>Groep</th></tr></thead>
          <tbody>
            <tr v-for="customer in listState.items" :key="customer.id" class="row-link" :class="{ off: customer.disabled }" :data-id="customer.id" @click="openCustomer($event, customer.id)">
              <td><a :href="`?id=${encodeURIComponent(customer.id)}`"><b>{{ customer.displayName }}</b></a></td>
              <td class="wrap">{{ customer.companyName || '' }}</td>
              <td class="wrap">{{ addressOneLine(customer.address) }}</td>
              <td>{{ customer.email }}</td>
              <td>{{ customer.phone }}</td>
              <td><template v-for="pill in pillsOf(customer)" :key="pill.key"><span :class="pill.className">{{ pill.label }}</span>{{ ' ' }}</template></td>
            </tr>
            <tr v-if="!listState.items.length"><td class="empty" colspan="6">{{ emptyText }}</td></tr>
          </tbody>
        </template>
      </table>
    </div>
    <div class="pager">
      <span id="k-count" class="muted small">{{ countText }}</span>
      <span class="spacer"></span>
      <button id="k-prev" class="btn small" type="button" :disabled="listState.offset <= 0" @click="turnPage(-1)">Vorige</button>
      <button id="k-next" class="btn small" type="button" :disabled="listState.offset + PAGE_SIZE >= listState.total" @click="turnPage(1)">Volgende</button>
    </div>
  </main>
</template>
