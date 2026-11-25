<script setup lang="ts">
// De klantkaart: gegevens, zakelijke instellingen, toegang, privacy en de offertes, werkorders en facturen van de klant.
// Een wijziging gaat met PATCH naar de server; het antwoord vervangt de getoonde gegevens (met een melding).
import { onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from '@/shared/toast'
import { formatEuro, formatShortDate } from '@/shared/format'
import AccessCard from './AccessCard.vue'
import BusinessCard from './BusinessCard.vue'
import ContactCard from './ContactCard.vue'
import DocumentsCard from './DocumentsCard.vue'
import PrivacyCard from './PrivacyCard.vue'
import { getCustomer, patchCustomer } from './customers-api'
import { INVOICE_STATUS, isForeignVat, pillsOf, QUOTE_STATUS, WORK_ORDER_STATUS } from './labels'
import type { CustomerDetail } from './types'

const props = defineProps<{ id: string }>()
const router = useRouter()

const detail = ref<CustomerDetail | null>(null)
const loadError = ref('')
const loading = ref(true)
const vatDraft = ref('')
const errors = reactive({ contact: '', business: '' })

/**
 * Haalt de klantkaart op en toont hem.
 * @returns Niets.
 */
async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  detail.value = null
  try {
    detail.value = await getCustomer(props.id)
    document.title = `${detail.value.customer.displayName} – Klanten – AquaTech Hub`
  } catch (error) {
    loadError.value = (error as Error).message
  } finally {
    loading.value = false
  }
}

/**
 * Zet een wijziging van de klant door en toont het resultaat.
 * @param body De te wijzigen velden.
 * @param errorKey Welke kaart de foutmelding toont.
 * @param message Melding na het opslaan.
 * @returns Niets.
 */
async function save(body: Record<string, unknown>, errorKey: 'contact' | 'business', message: string): Promise<void> {
  errors[errorKey] = ''
  if (!detail.value) return
  try {
    const out = await patchCustomer(detail.value.customer.id, body)
    detail.value = { ...detail.value, customer: { ...detail.value.customer, ...out.customer } }
    showToast(message)
  } catch (error) {
    errors[errorKey] = (error as Error).message
  }
}

/**
 * Terug naar de lijst.
 * @returns Niets.
 */
function backToList(): void {
  void router.push({ path: '/', query: {} })
}

onMounted(load)
watch(() => props.id, load)
</script>

<template>
  <main id="detail-view" class="dash wide">
    <div class="klanten-head"><button id="d-back" class="btn" type="button" @click="backToList">← Klanten</button></div>
    <div id="d-body">
      <p v-if="loading" class="muted">Laden…</p>
      <div v-else-if="loadError" class="notice">{{ loadError }} <a href="./">Terug naar de klanten</a></div>
      <template v-else-if="detail">
        <div class="klant-title">
          <h1>{{ detail.customer.displayName }}</h1>
          <template v-for="pill in pillsOf(detail.customer)" :key="pill.key"><span :class="pill.className">{{ pill.label }}</span>{{ ' ' }}</template>
          <span class="spacer"></span>
          <a v-if="detail.mayDossier" class="btn" :href="`../klantdossier/?klant=${encodeURIComponent(detail.dossierKey)}`">Klantdossier</a>
        </div>
        <div class="card-grid">
          <ContactCard :customer="detail.customer" :default-payment-days="detail.defaultPaymentDays" :manual-address="isForeignVat(vatDraft)" :error="errors.contact"
            @save="(body) => save(body, 'contact', 'Gegevens opgeslagen')" />
          <BusinessCard :customer="detail.customer" :may-price="detail.mayPrice" :error="errors.business"
            @save="(body) => save(body, 'business', 'Opgeslagen')" @vat-input="(value) => { vatDraft = value }"
            @approve="save({ customerGroup: 'zakelijk' }, 'business', 'Zakelijk account goedgekeurd: prijzen excl. btw')"
            @reject="save({ customerGroup: '' }, 'business', 'Aanvraag afgewezen: de klant blijft particulier')" />
          <AccessCard :customer="detail.customer" :invite-problem="detail.inviteProblem" />
          <PrivacyCard v-if="detail.mayPrice" :customer="detail.customer" @erased="load" />
        </div>
        <div class="docs-grid">
          <DocumentsCard title="Offertes" :rows="detail.quotes" :headers="[{ label: 'Nummer' }, { label: 'Titel' }, { label: 'Status' }, { label: 'Totaal', numeric: true }]" empty-text="Nog geen offertes voor deze klant.">
            <template #default="{ row }">
              <td><a :href="`../offertes/?id=${encodeURIComponent(row.id)}`">{{ row.number }}</a></td><td>{{ row.title }}</td><td>{{ QUOTE_STATUS[row.status] || row.status }}</td><td class="num">{{ formatEuro(row.total) }}</td>
            </template>
          </DocumentsCard>
          <DocumentsCard title="Werkorders" :rows="detail.workOrders" :headers="[{ label: 'Nummer' }, { label: 'Omschrijving' }, { label: 'Status' }, { label: 'Gepland', numeric: true }]" empty-text="Nog geen werkorders voor deze klant.">
            <template #default="{ row }">
              <td><a :href="`../werkorders/?id=${encodeURIComponent(row.id)}`">{{ row.number }}</a></td><td>{{ row.title }}</td><td>{{ WORK_ORDER_STATUS[row.status] || row.status }}</td><td class="num">{{ formatShortDate(row.plannedDate) }}</td>
            </template>
          </DocumentsCard>
          <DocumentsCard title="Facturen" :rows="detail.invoices" :headers="[{ label: 'Nummer' }, { label: 'Status' }, { label: 'Datum' }, { label: 'Totaal', numeric: true }]" empty-text="Nog geen facturen voor deze klant.">
            <template #default="{ row }">
              <td><a :href="`../facturen/?id=${encodeURIComponent(row.id)}`">{{ row.number || 'Concept' }}</a></td><td>{{ INVOICE_STATUS[row.status] || row.status }}{{ row.kind === 'credit' ? ' (credit)' : '' }}</td><td>{{ formatShortDate(row.invoiceDate) }}</td><td class="num">{{ formatEuro(row.total) }}</td>
            </template>
          </DocumentsCard>
        </div>
      </template>
    </div>
  </main>
</template>
