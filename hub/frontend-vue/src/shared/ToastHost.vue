<script setup lang="ts">
// Toont de melding uit toast.ts. Eén keer per pagina plaatsen (in de hoofdcomponent van de module).
import { useToastState } from './toast'

const toast = useToastState()
</script>

<template>
  <div id="toast" class="toast" :class="{ show: toast.visible, err: toast.visible && toast.isError }" role="status" aria-live="polite">{{ toast.message }}</div>
</template>
