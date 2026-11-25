<script setup lang="ts">
// Kaart "Privacy (AVG)": inzage-export in Excel en het wissen van persoonsgegevens met bevestiging (naam, wachtwoord, eventueel authenticatorcode).
import { computed, onMounted, ref } from 'vue'
import { ApiError } from '@/shared/api'
import { showToast } from '@/shared/toast'
import { anonymizeCustomer, anonymizePreview } from './customers-api'
import type { Customer } from './types'

const props = defineProps<{ customer: Customer }>()
const emit = defineEmits<{ erased: [] }>()

const confirmName = ref('')
const password = ref('')
const totp = ref('')
const needTotp = ref(false)
const weakNote = ref('')
const errorText = ref('')
const busy = ref(false)

const erased = computed(() => props.customer.username.startsWith('verwijderd-'))
const canErase = computed(() => !busy.value && confirmName.value.trim() === props.customer.displayName && Boolean(password.value))

/**
 * Wist de persoonsgegevens en laat de klantkaart opnieuw laden.
 * @returns Niets.
 */
async function erase(): Promise<void> {
  errorText.value = ''
  busy.value = true
  try {
    await anonymizeCustomer(props.customer.id, { confirm: confirmName.value.trim(), password: password.value, totp: totp.value.trim() })
    showToast('Persoonsgegevens gewist')
    emit('erased')
  } catch (error) {
    errorText.value = (error as Error).message
    if (error instanceof ApiError && error.code === 'totp_required') needTotp.value = true
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  if (erased.value) return
  try {
    const preview = await anonymizePreview(props.customer.id)
    const weak = preview.weakLinks
    if (weak && weak.count) weakNote.value = `Let op: ${weak.count} werkorder(s) hangen alleen via het klantrecord aan deze klant (mogelijk automatisch op gelijke naam gekoppeld: ${weak.numbers.join(', ')}${weak.count > weak.numbers.length ? ', …' : ''}). Die worden ook gewist. Controleer ze eerst.`
  } catch {
    // De waarschuwing is alleen een hulpmiddel; wissen blijft kunnen zonder.
  }
})
</script>

<template>
  <section id="c-privacy" class="card">
    <h3>Privacy (AVG)</h3>
    <p class="muted small">Inzage: een Excel met alle persoonsgegevens van deze klant. Wissen: de gegevens worden geanonimiseerd; definitieve facturen en de stukken waarop ze rusten blijven zeven jaar bewaard (bewaarplicht).</p>
    <div id="c-privacy-err" class="err" role="alert">{{ errorText }}</div>
    <div class="form-actions"><a class="btn" :href="`../api/customers/${encodeURIComponent(customer.id)}/privacy-export`" download>Inzage downloaden (Excel)</a></div>
    <p v-if="erased" class="muted small">Deze klant is gewist.</p>
    <template v-else>
      <label class="field">Typ de naam van de klant om te wissen
        <input id="c-erase-confirm" v-model="confirmName" type="text" autocomplete="off" :placeholder="customer.displayName"></label>
      <label class="field">Je wachtwoord (opnieuw)<input id="c-erase-password" v-model="password" type="password" autocomplete="current-password"></label>
      <label id="c-erase-totp-row" class="field" :hidden="!needTotp">Code uit je authenticator-app<input id="c-erase-totp" v-model="totp" type="text" inputmode="numeric" autocomplete="one-time-code"></label>
      <p id="c-erase-weak" class="muted small" role="status">{{ weakNote }}</p>
      <div class="form-actions"><button type="button" class="btn danger" data-erase :disabled="!canErase" @click="erase">Persoonsgegevens wissen</button></div>
    </template>
  </section>
</template>
