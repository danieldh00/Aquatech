<script setup lang="ts">
// Formulier voor een nieuwe klant: particulier of zakelijk, contactgegevens, adres via de postcodezoeker en optioneel
// meteen een uitnodiging om zelf een wachtwoord te kiezen. Een zakelijke klant (prijzen excl. btw) maakt alleen een beheerder aan.
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import AddressField from '@/shared/AddressField.vue'
import { ApiError } from '@/shared/api'
import { hasRight, loadMe } from '@/shared/shell'
import { showToast } from '@/shared/toast'
import { createCustomer, type NewCustomerBody } from './customers-api'
import { isForeignVat } from './labels'

const router = useRouter()
const form = reactive({ customerGroup: '' as '' | 'zakelijk', displayName: '', email: '', phone: '', companyName: '', kvkNumber: '', vatNumber: '', address: '', invite: false })
const formElement = ref<HTMLFormElement | null>(null)
const errorText = ref('')
const saving = ref(false)
/** null = nog niet bekend of het ophalen mislukte: dan blijft de keuze staan (de server weigert wat niet mag). */
const mayBusiness = ref<boolean | null>(null)

const isBusiness = computed(() => form.customerGroup === 'zakelijk')
const foreignVat = computed(() => isForeignVat(form.vatNumber))

/**
 * Bewaart een nieuwe klant en opent zijn klantkaart.
 * @returns Niets.
 */
async function saveNew(): Promise<void> {
  errorText.value = ''
  const body: NewCustomerBody = { displayName: form.displayName, email: form.email, phone: form.phone, address: form.address, customerGroup: form.customerGroup, invite: form.invite }
  if (isBusiness.value) Object.assign(body, { companyName: form.companyName, kvkNumber: form.kvkNumber, vatNumber: form.vatNumber })
  saving.value = true
  try {
    const out = await createCustomer(body)
    if (out.invite && !out.invite.sent) showToast(`Klant opgeslagen. Uitnodiging niet verstuurd: ${out.invite.problem}`, true)
    else showToast(out.invite ? 'Klant opgeslagen en uitnodiging verstuurd' : 'Klant opgeslagen')
    await router.push({ path: '/', query: { id: out.customer.id } })
  } catch (error) {
    errorText.value = (error as Error).message
    const field = error instanceof ApiError ? error.field : null
    const element = field && formElement.value ? formElement.value.elements.namedItem(field) : null
    if (element instanceof HTMLElement) element.focus()
  } finally {
    saving.value = false
  }
}

/**
 * Terug naar de lijst.
 * @returns Niets.
 */
function backToList(): void {
  void router.push({ path: '/', query: {} })
}

onMounted(async () => {
  formElement.value?.querySelector<HTMLInputElement>('input[name="displayName"]')?.focus()
  const me = await loadMe()
  if (me) mayBusiness.value = hasRight(me, 'beheer')
})
</script>

<template>
  <main id="new-view" class="dash wide">
    <div class="klanten-head"><button id="n-back" class="btn" type="button" @click="backToList">← Klanten</button></div>
    <section class="intro"><h1>Nieuwe klant</h1></section>
    <form id="n-form" ref="formElement" class="card" autocomplete="off" @submit.prevent="saveNew">
      <div class="form-grid cols-4">
        <label class="field">Soort klant
          <select v-model="form.customerGroup" name="customerGroup">
            <option value="">Particulier</option>
            <option v-if="mayBusiness !== false" value="zakelijk">Zakelijk</option>
          </select>
        </label>
        <label class="field">Naam
          <input v-model="form.displayName" name="displayName" required maxlength="80" placeholder="Jan de Vries">
        </label>
        <label class="field">E-mailadres
          <input v-model="form.email" name="email" type="email" maxlength="200">
        </label>
        <label class="field">Telefoon
          <input v-model="form.phone" name="phone" type="tel" maxlength="25">
        </label>
        <label class="field span-2" data-business :hidden="!isBusiness">Bedrijfsnaam
          <input v-model="form.companyName" name="companyName" maxlength="80">
        </label>
        <label class="field" data-business :hidden="!isBusiness">KvK-nummer
          <input v-model="form.kvkNumber" name="kvkNumber" inputmode="numeric" maxlength="12" placeholder="8 cijfers, leeg bij buitenland">
        </label>
        <label class="field" data-business :hidden="!isBusiness">Btw-nummer
          <input v-model="form.vatNumber" name="vatNumber" maxlength="20" placeholder="NL123456789B01 of ander EU-land">
        </label>
        <AddressField v-model="form.address" :manual="foreignVat" />
        <label class="field chk full"><input v-model="form.invite" type="checkbox" name="invite"> Meteen een uitnodiging mailen, zodat de klant zelf een wachtwoord kiest</label>
      </div>
      <div id="n-err" class="err" role="alert">{{ errorText }}</div>
      <div class="form-actions">
        <button class="btn primary" type="submit" :disabled="saving">Klant opslaan</button>
        <button id="n-cancel" class="btn" type="button" @click="backToList">Annuleren</button>
      </div>
    </form>
  </main>
</template>
