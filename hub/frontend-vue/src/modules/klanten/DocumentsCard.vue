<script setup lang="ts" generic="Row">
// Kleine tabel met documenten van de klant (offertes, werkorders of facturen), elk met een directe link.
// Is `rows` null, dan mag de aanvrager dit niet zien en verschijnt er niets.
defineProps<{ title: string; rows: Row[] | null; headers: { label: string; numeric?: boolean }[]; emptyText: string }>()
</script>

<template>
  <section v-if="rows !== null" class="card">
    <h3>{{ title }}{{ rows.length ? ` (${rows.length})` : '' }}</h3>
    <table v-if="rows.length" class="mini">
      <thead><tr><th v-for="header in headers" :key="header.label" :class="{ num: header.numeric }">{{ header.label }}</th></tr></thead>
      <tbody><tr v-for="(row, index) in rows" :key="index"><slot :row="row"></slot></tr></tbody>
    </table>
    <p v-else class="empty">{{ emptyText }}</p>
  </section>
</template>
