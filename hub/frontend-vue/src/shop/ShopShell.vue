<script setup lang="ts">
// De schil om elke webshoppagina: mededeling, kop met zoeken en winkelwagen, menu, voet. Zelfde markup en klassen als de oude
// `layout()` in de backend; de inhoud van de pagina zelf komt op de plek van de markering `shop-body` (de backend zet die erin).
import { computed } from 'vue'
import Marker from './Marker'
import MenuFly from './MenuFly.vue'
import MenuFold from './MenuFold.vue'
import ShopIcon from './ShopIcon'
import type { ShellProps } from './types'

const props = defineProps<{ shell: ShellProps }>()

/** Adres van een bestand onder assets/ met de versie erbij (de browser pakt na een update nooit een oude kopie). */
function asset(name: string): string {
  return `${props.shell.root}assets/${name}?v=${props.shell.assetVersion}`
}

/** Startadres van de shop. */
const home = computed(() => props.shell.root || './')

/** Aantal artikelen als tekst voor schermlezers: "1 artikel" of "3 artikelen". */
const cartWord = computed(() => (props.shell.visitor.cartCount === 1 ? 'artikel' : 'artikelen'))

/** De regels met contactgegevens in de voet: tekst of link, in vaste volgorde, alleen wat is ingevuld. */
const contactLines = computed(() => {
  const { contact } = props.shell
  const lines: Array<{ text: string, href?: string }> = []
  if (contact.kvk) lines.push({ text: `K.v.k.: ${contact.kvk}` })
  if (contact.address) lines.push({ text: contact.address })
  if (contact.email) lines.push({ text: contact.email, href: `mailto:${contact.email}` })
  if (contact.phone) lines.push({ text: contact.phone, href: contact.phoneHref })
  return lines
})
</script>

<template>
  <div v-if="shell.notice.enabled && shell.notice.text" :class="['shop-notice', `kleur-${shell.notice.color || 'purple'}`]">{{ shell.notice.text }}</div>
  <header class="shop-head">
    <div class="shop-bar">
      <a class="shop-brand" :href="home"><img :src="asset('aquatechshop-logo.png')" alt="Aquatechshop.nl" width="216" height="44"></a>
      <form class="shop-search" :action="`${shell.root}zoeken/`" method="get" role="search">
        <input type="search" name="q" :value="shell.query" placeholder="Zoek op product of artikelnummer" aria-label="Zoeken" maxlength="80" autocomplete="off" :data-suggest="`${shell.root}zoeken/suggesties/`">
        <button type="submit" aria-label="Zoeken"><ShopIcon name="search" /></button>
      </form>
      <a v-if="shell.contact.phone" class="shop-phone" :href="shell.contact.phoneHref" :aria-label="`Klantenservice ${shell.contact.phone}`"><ShopIcon name="phone" /><span><small>Klantenservice</small><strong>{{ shell.contact.phone }}</strong></span></a>
      <div class="shop-actions">
        <a v-if="shell.visitor.staff" class="shop-action shop-admin" :href="`${shell.root}app/`" title="Naar het beheer"><ShopIcon name="admin" /><span>Beheer</span></a>
        <a class="shop-action" :href="`${shell.root}account/`" title="Inloggen of mijn account" aria-label="Account"><ShopIcon name="user" /><span>Account</span></a>
        <a v-if="shell.visitor.ordering" class="shop-action cart" :href="`${shell.root}winkelwagen/`" title="Naar je winkelwagen" :aria-label="`Winkelwagen, ${shell.visitor.cartCount} ${cartWord}`"><ShopIcon name="cart" /><span>Winkelwagen</span><b>{{ shell.visitor.cartCount }}</b></a>
        <span v-else class="shop-action cart" aria-disabled="true" title="De winkelwagen volgt binnenkort"><ShopIcon name="cart" /><span>Winkelwagen</span><b>0</b></span>
      </div>
    </div>
    <nav class="shop-nav" aria-label="Productgroepen">
      <ul class="nav-bar">
        <li v-for="link in shell.menu.aboutLinks" :key="link.href" class="nav-about"><a :href="link.href">{{ link.title }}</a></li>
        <li v-for="group in shell.menu.groups" :key="group.name" class="nav-group">
          <span class="nav-heading" tabindex="0">{{ group.name }}</span>
          <ul class="nav-drop"><MenuFly :categories="group.categories" :root="shell.root" /></ul>
        </li>
        <Marker :text="`planner:${shell.root}`" />
      </ul>
    </nav>
    <details class="shop-menu">
      <summary><ShopIcon name="menu" /><span>Alle productgroepen</span></summary>
      <ul>
        <li v-if="shell.visitor.staff"><a :href="`${shell.root}app/`">Naar het beheer</a></li>
        <li v-for="group in shell.menu.groups" :key="group.name">
          <details>
            <summary>{{ group.name }}</summary>
            <ul><MenuFold :categories="group.categories" :root="shell.root" /></ul>
          </details>
        </li>
        <li v-if="shell.visitor.wholesale"><a :href="`${shell.root}groothandel/`">Groothandel</a></li>
        <li v-for="page in shell.menu.extraPages" :key="page.href"><a :href="page.href">{{ page.title }}</a></li>
        <Marker :text="`planner:${shell.root}`" />
      </ul>
    </details>
  </header>
  <main :class="['shop-main', { wide: shell.wide }]">
    <Marker text="shop-body" />
  </main>
  <footer class="shop-foot">
    <div class="foot-grid">
      <div>
        <strong>Aquatechshop.nl</strong>
        <p>
          <template v-for="(line, index) in contactLines" :key="index">
            <br v-if="index > 0">
            <a v-if="line.href" :href="line.href">{{ line.text }}</a>
            <template v-else>{{ line.text }}</template>
          </template>
        </p>
      </div>
      <div>
        <strong>Klantenservice</strong>
        <ul>
          <li v-if="shell.contact.email"><a :href="`mailto:${shell.contact.email}`">Contact</a></li>
          <li><a :href="`${shell.root}pagina/herroepingsrecht/`">Retourbeleid</a></li>
          <li><a :href="`${shell.root}pagina/algemene-voorwaarden/`">Algemene voorwaarden</a></li>
        </ul>
      </div>
      <div>
        <strong>Account</strong>
        <ul>
          <li><a :href="`${shell.root}account/`">Mijn account</a></li>
          <li><a :href="`${shell.root}account/`">Inloggen of registreren</a></li>
        </ul>
      </div>
      <div>
        <strong>Over ons</strong>
        <p>{{ shell.footer.about }}</p>
        <p><a :href="`${shell.root}over-ons/`">Lees ons verhaal</a></p>
        <ul v-if="shell.footer.pages.length"><li v-for="page in shell.footer.pages" :key="page.href"><a :href="page.href">{{ page.title }}</a></li></ul>
      </div>
    </div>
    <nav class="foot-legal" aria-label="Voorwaarden">
      <a v-for="link in shell.footer.legal" :key="link.href" :href="link.href">{{ link.title }}</a>
      <button v-if="shell.visitor.measuring" type="button" class="link-button" data-consent-settings>Cookie-instellingen</button>
    </nav>
    <div class="foot-note">
      <span>{{ shell.visitor.business ? 'Je ziet zakelijke prijzen: alle prijzen zijn exclusief btw.' : 'Alle prijzen zijn inclusief btw.' }}</span>
      <img :src="asset('betaalmethoden.png')" alt="Betaalmethoden" width="286" height="26" loading="lazy">
    </div>
  </footer>
</template>
