<script setup lang="ts">
// Adresveld met de postcodezoeker van de schil (shared/address-lookup.js, PDOK via onze eigen server).
// De zoeker bouwt zijn eigen rijtje Postcode / Huisnr. / Toev. boven het veld en vult het alleen-lezen adresveld;
// dit component geeft het adres als gewone tekst weer en meldt elke wijziging via v-model. De kaart `addr-result`
// en de klassen zijn dezelfde als in de oude modules, dus het ziet er hetzelfde uit. Let op: de zoeker zet zijn rijtje als
// broertje vóór dit label in de ouder (`.form-grid > .addr-lookup` in layout.css); gebruik het component dus direct in een
// `.form-grid` en niet binnen een v-if of v-for die het label los van zijn ouder verwijdert.
import { onMounted, ref, watch } from 'vue'
import { shellWindow } from './shell'

const props = withDefaults(defineProps<{ modelValue: string; manual?: boolean; label?: string }>(), { manual: false, label: 'Adres' })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const field = ref<HTMLTextAreaElement | null>(null)
const text = ref<HTMLElement | null>(null)

/**
 * Zet het handmatig-vlag op het veld: de zoeker laat dan vrij typen toe (adres buiten Nederland).
 * @returns Niets.
 */
function syncManual(): void {
  if (!field.value) return
  if (props.manual) field.value.dataset.addressManual = '1'
  else delete field.value.dataset.addressManual
}

/**
 * Zet de waarde van buiten (bijvoorbeeld na een reset) in het veld en laat de zoeker en de tekst meebewegen.
 * @param value Het nieuwe adres.
 * @returns Niets.
 */
function setFromOutside(value: string): void {
  const element = field.value
  if (!element || element.value === value) return
  element.value = value
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

onMounted(() => {
  const element = field.value
  if (!element) return
  element.value = props.modelValue
  syncManual()
  const lookup = shellWindow().AddressLookup
  if (lookup) {
    lookup.enhance(element)
    if (text.value) lookup.mirror(element, text.value)
  } else if (text.value) {
    text.value.textContent = props.modelValue
  }
  element.addEventListener('input', () => emit('update:modelValue', element.value))
})

watch(() => props.modelValue, setFromOutside)
watch(() => props.manual, syncManual)
</script>

<template>
  <label class="field full addr-result">{{ label }}
    <span ref="text" class="addr-text"></span>
    <textarea ref="field" name="address" hidden maxlength="400"></textarea>
  </label>
</template>
