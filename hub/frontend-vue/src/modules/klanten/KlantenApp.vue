<script setup lang="ts">
// Hoofdcomponent van de klantenmodule. De weergave volgt uit het adres, net als in de oude pagina:
// `?id=…` = klantkaart, `?nieuw` = nieuwe klant, anders de lijst. Na terugkeer uit de bfcache (terugknop) wordt de weergave ververst.
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import ToastHost from '@/shared/ToastHost.vue'
import { shellWindow } from '@/shared/shell'
import CustomerDetail from './CustomerDetail.vue'
import CustomerList from './CustomerList.vue'
import CustomerNew from './CustomerNew.vue'

const route = useRoute()
const refreshKey = ref(0)

const customerId = computed(() => (typeof route.query.id === 'string' ? route.query.id : ''))
const isNew = computed(() => !customerId.value && 'nieuw' in route.query)
const view = computed(() => (customerId.value ? 'detail' : isNew.value ? 'new' : 'list'))
const viewKey = computed(() => `${view.value}:${customerId.value}:${refreshKey.value}`)

/**
 * Zet de paginatitel bij de weergave (de klantkaart zet zijn eigen titel zodra de klant geladen is).
 * @returns Niets.
 */
function updateTitle(): void {
  if (view.value !== 'detail') document.title = 'Klanten – AquaTech Hub'
}

onMounted(() => {
  updateTitle()
  shellWindow().AquatechCommon?.onReturn(() => { refreshKey.value += 1 })
})
</script>

<template>
  <CustomerDetail v-if="view === 'detail'" :id="customerId" :key="viewKey" />
  <CustomerNew v-else-if="view === 'new'" :key="viewKey" />
  <CustomerList v-else :key="viewKey" />
  <ToastHost />
</template>
