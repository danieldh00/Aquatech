<script setup lang="ts">
// Kaart "Toegang": kan de klant inloggen, en een uitnodiging sturen om een wachtwoord te kiezen.
import { ref } from 'vue'
import { showToast } from '@/shared/toast'
import { inviteCustomer } from './customers-api'
import type { Customer } from './types'

const props = defineProps<{ customer: Customer; inviteProblem: string }>()
const errorText = ref('')
const busy = ref(false)

/**
 * Stuurt de uitnodiging.
 * @returns Niets.
 */
async function sendInvite(): Promise<void> {
  errorText.value = ''
  busy.value = true
  try {
    await inviteCustomer(props.customer.id)
    showToast('Uitnodiging verstuurd')
  } catch (error) {
    errorText.value = (error as Error).message
  }
  busy.value = false
}
</script>

<template>
  <section class="card">
    <h3>Toegang</h3>
    <dl class="fact-list">
      <dt>Inlog</dt><dd>{{ customer.hasLogin ? `Ja${customer.emailVerified ? ' (e-mailadres bevestigd)' : ''}` : 'Nee, nog geen wachtwoord gekozen' }}</dd>
      <dt>Gebruikersnaam</dt><dd>{{ customer.username }}</dd>
      <template v-if="customer.disabled"><dt>Status</dt><dd>Uitgeschakeld</dd></template>
    </dl>
    <p class="muted small">{{ customer.hasLogin ? 'De klant kan al inloggen en wijzigt het wachtwoord zelf via Wachtwoord vergeten.' : 'Stuur een uitnodiging per e-mail; de klant kiest zelf een wachtwoord (de link werkt zeven dagen).' }}
      Wachtwoord, uitschakelen en verwijderen doe je in <a href="../beheer/#users">Beheer &gt; Gebruikers</a>.</p>
    <div id="c-access-err" class="err" role="alert">{{ errorText }}</div>
    <div class="form-actions">
      <button type="button" class="btn" data-invite :disabled="Boolean(inviteProblem) || customer.disabled || busy" @click="sendInvite">Uitnodiging sturen</button>
      <span v-if="inviteProblem" class="muted small">{{ inviteProblem }}</span>
    </div>
  </section>
</template>
