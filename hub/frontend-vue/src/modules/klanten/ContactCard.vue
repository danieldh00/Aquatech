<script setup lang="ts">
// Kaart "Gegevens" op de klantkaart: naam, e-mail, telefoon, betaaltermijn, documenttaal, herinneringen en adres.
import { reactive, watch } from 'vue'
import AddressField from '@/shared/AddressField.vue'
import { shellWindow } from '@/shared/shell'
import type { Customer } from './types'

const props = defineProps<{ customer: Customer; defaultPaymentDays: number; manualAddress: boolean; error: string }>()
const emit = defineEmits<{ save: [body: Record<string, unknown>] }>()

const form = reactive({ displayName: '', email: '', phone: '', paymentDays: '', documentLanguage: '', remindersOff: false, address: '' })
const languages = Object.entries(shellWindow().DocText?.LANGUAGES ?? { nl: 'Nederlands', en: 'English' })

/**
 * Zet het formulier terug op de gegevens van de klant (bij het openen en na elke wijziging).
 * @returns Niets.
 */
function resetForm(): void {
  const { customer } = props
  Object.assign(form, {
    displayName: customer.displayName, email: customer.email, phone: customer.phone,
    paymentDays: customer.paymentDays == null ? '' : String(customer.paymentDays),
    documentLanguage: customer.documentLanguage, remindersOff: Boolean(customer.remindersOff), address: customer.address,
  })
}

/**
 * Stuurt de ingevulde gegevens naar boven om op te slaan.
 * @returns Niets.
 */
function submit(): void {
  emit('save', { displayName: form.displayName, email: form.email, phone: form.phone, address: form.address, paymentDays: form.paymentDays, documentLanguage: form.documentLanguage, remindersOff: form.remindersOff })
}

watch(() => props.customer, resetForm, { immediate: true })
</script>

<template>
  <form id="c-contact" class="card" autocomplete="off" @submit.prevent="submit">
    <h3>Gegevens</h3>
    <div class="form-grid">
      <label class="field full">Naam<input v-model="form.displayName" name="displayName" required maxlength="80"></label>
      <label class="field">E-mailadres<input v-model="form.email" name="email" type="email" maxlength="200"></label>
      <label class="field">Telefoon<input v-model="form.phone" name="phone" type="tel" maxlength="25"></label>
      <label class="field">Betaaltermijn (dagen)<input :value="form.paymentDays" name="paymentDays" type="number" min="0" max="365" step="1" inputmode="numeric" placeholder="Standaard" @input="form.paymentDays = ($event.target as HTMLInputElement).value"><span class="hint">Leeg: de standaard van {{ defaultPaymentDays }} dagen. Komt op de offerte en de factuur.</span></label>
      <label class="field">Documenttaal
        <select v-model="form.documentLanguage" name="documentLanguage"><option v-for="[key, label] in languages" :key="key" :value="key">{{ label }}</option></select>
        <span class="hint">Taal van offertes, facturen en de mails daarover.</span>
      </label>
      <label class="field full chk"><input v-model="form.remindersOff" type="checkbox" name="remindersOff"> Geen automatische betalingsherinneringen of aanmaningen sturen<span class="hint">Voor deze klant gaan er geen mails uit voor vervallen facturen; je volgt ze zelf op.</span></label>
      <AddressField v-model="form.address" :manual="manualAddress" />
    </div>
    <div id="c-contact-err" class="err" role="alert">{{ error }}</div>
    <div class="form-actions"><button class="btn primary" type="submit">Gegevens opslaan</button></div>
  </form>
</template>
