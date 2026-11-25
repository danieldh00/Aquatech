<script setup lang="ts">
/**
 * W0-spike: de productpagina van de webshop als Vue-component (alleen de kern:
 * kruimelpad, afbeelding, naam, artikelnummer, prijs, voorraad en bestelformulier).
 * Dezelfde klassen en volgorde als `productPage` in storefront-pages.js, zodat de
 * uitvoer vergeleken kan worden met de bestaande pagina.
 */
import { computed } from 'vue';

interface Product {
  name: string;
  code: string;
  slug: string;
  image: string;
  unit: string;
  vatRate: number;
  priceIncl: number;
  inStock: boolean;
  stockQty: number | null;
  groupSlug: string;
  groupName: string;
  categorySlug: string;
  categoryName: string;
}

const props = defineProps<{ product: Product; ordering: boolean }>();

const root = '../../';

/**
 * Bedrag als `€ 12,50`, zoals `formatPrice` in de bestaande shop.
 * @param amount Het bedrag in euro.
 * @returns De opgemaakte tekst.
 */
function formatPrice(amount: number): string {
  return `€ ${amount.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const stockLabel = computed(() => {
  if (!props.product.inStock) return 'Niet op voorraad';
  const quantity = props.product.stockQty;
  return quantity !== null && quantity >= 1 && quantity <= 5 ? `Nog ${quantity} op voorraad` : 'Op voorraad';
});
</script>

<template>
  <nav class="crumbs" aria-label="Kruimelpad"><a :href="root">Shop</a> › <a :href="`${root}groep/${product.groupSlug}/`">{{ product.groupName }}</a> › <a :href="`${root}categorie/${product.categorySlug}/`">{{ product.categoryName }}</a> › <span>{{ product.name }}</span></nav>
  <article class="product-detail">
    <div class="product-image large"><img v-if="product.image" :src="product.image" :alt="product.name"><span v-else class="no-image" aria-hidden="true"></span></div>
    <div class="product-info">
      <h1>{{ product.name }}</h1>
      <p class="sku">Artikelnummer: {{ product.code }}</p>
      <p class="price">{{ formatPrice(product.priceIncl) }} <small>incl. {{ product.vatRate }}% btw · per {{ product.unit }}</small></p>
      <p :class="['stock', product.inStock ? 'in' : 'out']">{{ stockLabel }}</p>
      <form v-if="ordering" class="product-order" method="post" :action="`${root}winkelwagen/`">
        <input type="hidden" name="action" value="add"><input type="hidden" name="code" :value="product.code" data-order-code>
        <input type="number" name="qty" value="1" min="1" max="99" aria-label="Aantal" :disabled="!product.inStock"><button class="button" type="submit" :disabled="!product.inStock">In winkelwagen</button>
      </form>
      <template v-else><button class="button" type="button" disabled>In winkelwagen</button><p class="note">Online bestellen volgt binnenkort.</p></template>
    </div>
  </article>
</template>
