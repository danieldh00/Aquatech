<script setup lang="ts">
// Kaart "Zakelijk en prijzen": klantgroep, bedrijfsgegevens, groothandel en een aanvraag voor een zakelijk account.
// Wie geen prijzen mag wijzigen (`mayPrice` onwaar) ziet de klantgroep en groothandel alleen.
import { computed, reactive, watch } from 'vue'
import type { Customer } from './types'

const props = defineProps<{ customer: Customer; mayPrice: boolean; error: string }>()
const emit = defineEmits<{ save: [body: Record<string, unknown>]; 'vat-input': [vatNumber: string]; approve: []; reject: [] }>()

const form = reactive({ customerGroup: '' as '' | 'zakelijk', companyName: '', kvkNumber: '', vatNumber: '', wholesale: false, wholesaleDiscount: '0' as string | number })

const isBusiness = computed(() => (props.mayPrice ? form.customerGroup === 'zakelijk' : props.customer.customerGroup === 'zakelijk'))
const hasRequest = computed(() => props.customer.businessRequest === 'aangevraagd')

/**
 * Zet het formulier terug op de gegevens van de klant (bij het openen en na elke wijziging).
 * @returns Niets.
 */
function resetForm(): void {
  const { customer } = props
  Object.assign(form, {
    customerGroup: customer.customerGroup, companyName: customer.companyName, kvkNumber: customer.kvkNumber, vatNumber: customer.vatNumber,
    wholesale: Boolean(customer.wholesale), wholesaleDiscount: String(customer.wholesaleDiscount || 0),
  })
  emit('vat-input', customer.vatNumber)
}

/**
 * Bouwt de te bewaren velden: groep alleen met recht op prijzen, bedrijfsgegevens alleen bij zakelijk, groothandel alleen bij beide.
 * @returns Niets.
 */
function submit(): void {
  const body: Record<string, unknown> = {}
  if (props.mayPrice) body.customerGroup = form.customerGroup
  if (isBusiness.value) Object.assign(body, { companyName: form.companyName, kvkNumber: form.kvkNumber, vatNumber: form.vatNumber })
  if (props.mayPrice && isBusiness.value) Object.assign(body, { wholesale: form.wholesale, ...(form.wholesale ? { wholesaleDiscount: Number(form.wholesaleDiscount) || 0 } : {}) })
  if (!Object.keys(body).length) return
  emit('save', body)
}

watch(() => props.customer, resetForm, { immediate: true })
watch(() => form.vatNumber, (value) => emit('vat-input', value))
</script>

<template>
  <form id="c-business" class="card" autocomplete="off" @submit.prevent="submit">
    <h3>Zakelijk en prijzen</h3>
    <div v-if="hasRequest" class="request-banner">
      <span class="pill aanvraag">Aanvraag zakelijk</span><span>De klant vroeg een zakelijk account aan.</span><span class="spacer"></span>
      <template v-if="mayPrice">
        <button type="button" class="btn small" data-approve @click="emit('approve')">Goedkeuren</button>{{ ' ' }}
        <button type="button" class="btn small" data-reject @click="emit('reject')">Afwijzen</button>
      </template>
    </div>
    <div class="form-grid">
      <label v-if="mayPrice" class="field">Klantgroep
        <select v-model="form.customerGroup" name="customerGroup"><option value="">Particulier</option><option value="zakelijk">Zakelijk</option></select>
        <span class="hint">Zakelijk: prijzen excl. btw in de webshop.</span>
      </label>
      <div v-else class="field">Klantgroep<b>{{ isBusiness ? 'Zakelijk' : 'Particulier' }}</b><span class="hint">Alleen een beheerder wijzigt de klantgroep.</span></div>
      <label class="field full" data-business :hidden="!isBusiness">Bedrijfsnaam<input v-model="form.companyName" name="companyName" maxlength="80"></label>
      <label class="field" data-business :hidden="!isBusiness">KvK-nummer<input v-model="form.kvkNumber" name="kvkNumber" inputmode="numeric" maxlength="12"><span class="hint">Leeg laten bij een buitenlands bedrijf.</span></label>
      <label class="field" data-business :hidden="!isBusiness">Btw-nummer<input v-model="form.vatNumber" name="vatNumber" maxlength="20"><span class="hint">Optioneel.</span></label>
      <template v-if="mayPrice">
        <label class="field chk" data-business :hidden="!isBusiness"><input v-model="form.wholesale" type="checkbox" name="wholesale"> Groothandelsklant (groothandelsvenster in de webshop)</label>
        <label class="field" data-wholesale :hidden="!isBusiness || !form.wholesale"><span>Vaste korting (%)</span><input v-model="form.wholesaleDiscount" name="wholesaleDiscount" type="number" min="0" max="50" step="0.5"><span class="hint">Naast de staffelkorting geldt de hoogste van de twee.</span></label>
      </template>
      <div v-else-if="customer.wholesale" class="field" data-business :hidden="!isBusiness">Groothandel<b>Ja, vaste korting {{ customer.wholesaleDiscount || 0 }}%</b></div>
    </div>
    <div id="c-business-err" class="err" role="alert">{{ error }}</div>
    <div class="form-actions"><button class="btn primary" type="submit">Opslaan</button></div>
  </form>
</template>
