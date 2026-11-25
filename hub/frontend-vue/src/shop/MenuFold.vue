<script setup lang="ts">
// Eén niveau van het ingeklapte menu voor smalle schermen: subcategorieën klappen open met "Alles in …" bovenaan.
import type { MenuCategory } from './types'

defineProps<{ categories: MenuCategory[], root: string }>()
</script>

<template>
  <template v-for="category in categories" :key="category.slug">
    <li v-if="category.children.length">
      <details>
        <summary>{{ category.name }}</summary>
        <ul>
          <li><a :href="`${root}categorie/${category.slug}/`">Alles in {{ category.name }}</a></li>
          <MenuFold :categories="category.children" :root="root" />
        </ul>
      </details>
    </li>
    <li v-else><a :href="`${root}categorie/${category.slug}/`">{{ category.name }}</a></li>
  </template>
</template>
