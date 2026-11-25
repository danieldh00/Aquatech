<script setup lang="ts">
// Eén niveau van het uitklapmenu voor brede schermen: een link, bij subcategorieën met een flyout ernaast (alleen CSS).
import type { MenuCategory } from './types'

defineProps<{ categories: MenuCategory[], root: string }>()
</script>

<template>
  <template v-for="category in categories" :key="category.slug">
    <li v-if="category.children.length" class="has-sub">
      <a :href="`${root}categorie/${category.slug}/`">{{ category.name }}</a>
      <ul class="nav-drop nav-fly"><MenuFly :categories="category.children" :root="root" /></ul>
    </li>
    <li v-else><a :href="`${root}categorie/${category.slug}/`">{{ category.name }}</a></li>
  </template>
</template>
