// @vitest-environment node
// Pariteit van de webshopschil: de Vue-schil geeft dezelfde HTML als de oude `layout()` in de backend, voor elke combinatie van
// bezoeker (particulier, zakelijk, groothandel, medewerker), winkelwagen, meting, mededeling en menu.
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { renderShell } from '../../src/shop/ssr-entry'

const require = createRequire(import.meta.url)
const pages = require('../../../backend/src/webshop/storefront-pages.js')
const VueShell = require('../../../backend/src/webshop/vue-shell.js')
const { DEFAULT_SITE } = require('../../../backend/src/webshop/shop-content.js')

/** Een menu met een verborgen categorie, een diepe tak en een categorie zonder subcategorieën. */
const GROUPS = [
  { slug: 'beregening', name: 'Beregening', categories: [
    { slug: 'sproeiers', name: 'Sproeiers & <spuitkoppen>', hidden: false, children: [
      { slug: 'rotators', name: 'Rotators', hidden: false, children: [{ slug: 'mp-rotator', name: 'MP "Rotator"', hidden: false, children: [] }] },
      { slug: 'oud', name: 'Oud', hidden: true, children: [] },
    ] },
    { slug: 'slang', name: 'Slang', hidden: false, children: [] },
    { slug: 'verborgen', name: 'Verborgen', hidden: true, children: [] },
  ] },
  { slug: 'pompen', name: 'Pompen', categories: [{ slug: 'tuinpompen', name: 'Tuinpompen', hidden: false, children: [] }] },
]

const PAGES = [
  { slug: 'over-ons', title: 'Over ons', menu: true, footer: true },
  { slug: 'veelgestelde-vragen', title: 'Veelgestelde vragen', menu: true, footer: true },
  { slug: 'verzending', title: 'Verzending & levering', menu: false, footer: true },
  { slug: 'privacyverklaring', title: 'Privacy', menu: false, footer: false },
]

/** Maakt de HTML vergelijkbaar: witruimte tussen tags weg, lege elementen uitgeschreven, kenmerken ongewijzigd. */
function normalize(html: string): string {
  return html
    .replace(/<(circle|path|rect)([^>]*?)\s*\/>/g, '<$1$2></$1>')
    .replace(/<!--(?!shop-body|planner)[^>]*-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/> </g, '><')
    .replace(/\s*\/>/g, '>')
    .trim()
}

const SCENARIOS: Array<{ naam: string, shop: Record<string, unknown>, site?: (site: any) => void, root: string, query?: string, wide?: boolean }> = [
  { naam: 'bezoeker zonder bestellen', shop: { ordering: false, cartCount: 0 }, root: '' },
  { naam: 'bestellen, 1 artikel', shop: { ordering: true, cartCount: 1 }, root: '../' },
  { naam: 'bestellen, 3 artikelen, zoekterm met tekens', shop: { ordering: true, cartCount: 3 }, root: '../../', query: 'rotator "mp" <x> & co' },
  { naam: 'zakelijk met meting', shop: { ordering: true, cartCount: 2, business: true, analytics: 'G-ABC123DEF4', baseUrl: 'https://shop.example/' }, root: '' },
  { naam: 'groothandel', shop: { ordering: true, cartCount: 0, business: true, wholesale: true }, root: '', wide: true },
  { naam: 'medewerker met Clarity', shop: { ordering: true, cartCount: 0, staff: true, clarity: 'abc123' }, root: '../' },
  { naam: 'mededeling zonder kleur en lege contactgegevens', shop: { ordering: true, cartCount: 0 }, root: '', site: (site) => { site.notice = { enabled: true, text: 'Let op: <b>feestdagen</b> & drukte', color: '' }; site.contact = { phone: '', email: '', kvk: '', address: '' } } },
  { naam: 'mededeling paars met alle contactgegevens', shop: { ordering: true, cartCount: 0 }, root: '../', site: (site) => { site.notice = { enabled: true, text: 'Welkom', color: 'green' }; site.contact = { phone: '06 12 34 56 78', email: 'info@example.nl', kvk: '12345678', address: 'Straat 1, Nunspeet' } } },
]

beforeAll(() => {
  VueShell.configure(null)
})

describe('webshopschil: Vue tegen de oude layout()', () => {
  for (const scenario of SCENARIOS) {
    it(`geeft dezelfde HTML: ${scenario.naam}`, async () => {
      const site = JSON.parse(JSON.stringify(DEFAULT_SITE))
      scenario.site?.(site)
      const shop = { indexing: false, ordering: false, cartCount: 0, business: false, staff: false, wholesale: false, baseUrl: '', analytics: '', clarity: '', captcha: '', ...scenario.shop }
      const options = { root: scenario.root, title: 'Titel', description: 'Omschrijving', body: '<section id="inhoud"><p>Hallo $& wereld</p></section>', groups: GROUPS, query: scenario.query || '', wide: Boolean(scenario.wide), canonicalPath: '' }
      const content = { site, pages: PAGES }

      VueShell.configure(null)
      const oud = pages.renderWith(content, () => pages.layout(options), shop)
      VueShell.configure(renderShell)
      const nieuw = await pages.renderWith(content, () => pages.layout(options), shop)
      VueShell.configure(null)

      expect(typeof oud).toBe('string')
      expect(normalize(nieuw)).toBe(normalize(oud))
      expect(nieuw).not.toContain('vue-shell')
      expect(nieuw).toContain('<section id="inhoud"><p>Hallo $& wereld</p></section>')
    })
  }

  it('laat de oude schil staan als de Vue-schil niet geladen is', () => {
    VueShell.configure(null)
    const html = pages.renderWith({ site: DEFAULT_SITE, pages: PAGES }, () => pages.layout({ root: '', title: 'T', description: 'O', body: '<p>x</p>', groups: GROUPS }))
    expect(typeof html).toBe('string')
    expect(html).toContain('class="shop-head"')
  })
})
