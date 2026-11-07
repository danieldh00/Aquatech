// Vindbaarheid van de webshop voor zoekmachines en AI-zoekers: gestructureerde
// gegevens (Schema.org JSON-LD), robots.txt, sitemap.xml, llms.txt en de
// productfeed voor Google Merchant Center. Alles is zuivere functies zonder
// database of Express; de shop (storefront.js) geeft de gegevens door en
// storefront-pages.js zet de uitkomst in de pagina's.

/** Zoekmachines en AI-crawlers die de shop expliciet mogen lezen (robots.txt). */
const ALLOWED_CRAWLERS = [
  'Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'PerplexityBot', 'Perplexity-User',
  'ClaudeBot', 'Claude-SearchBot', 'Claude-User', 'Google-Extended', 'Applebot-Extended',
];
/** Paden (onder de shop) die geen zoekresultaat horen te zijn: persoonlijk, een formulier of een tussenstap. */
const PRIVATE_PATHS = ['app/', 'api/', 'winkelwagen/', 'afrekenen/', 'account/', 'inloggen/', 'registreren/', 'planner/', 'bestelling/', 'bestellingen/', 'groothandel/', 'zoeken/', 'adres/', 'mollie/', 'zakelijk-aanvraag/'];
/** Maximaal aantal adressen in de sitemap (grens van het sitemapformaat). */
const MAX_SITEMAP_URLS = 50000;
/** Schema.org-adressen voor de beschikbaarheid. */
const AVAILABILITY = { in: 'https://schema.org/InStock', out: 'https://schema.org/OutOfStock' };

/**
 * Maakt tekst veilig voor in XML (tekst en attributen).
 * @param {*} value De tekst.
 * @returns {string} De ontsnapte tekst.
 */
function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

/**
 * Maakt van een pad in de shop een volledig adres.
 * @param {string} baseUrl Het webadres van de shop, met een slash achteraan.
 * @param {string} relativePath Het pad vanaf de startpagina, zonder slash vooraan ('' = startpagina).
 * @returns {string} Het volledige adres.
 */
function absoluteUrl(baseUrl, relativePath) {
  return `${baseUrl}${String(relativePath || '').replace(/^\/+/, '')}`;
}

/**
 * Het volledige adres van een productafbeelding: een eigen afbeelding ('own:<id>') komt van de shop zelf, anders is het het https-adres van het webshopproduct.
 * @param {string} baseUrl Het webadres van de shop, met een slash achteraan.
 * @param {string} image De waarde uit de catalogus ('own:<id>', een https-adres of leeg).
 * @returns {string} Het volledige adres, of een lege tekst zonder afbeelding.
 */
function imageUrlOf(baseUrl, image) {
  const text = String(image || '');
  if (text.startsWith('own:')) return absoluteUrl(baseUrl, `artikelfoto/${text.slice(4)}`);
  return /^https:\/\//.test(text) ? text : '';
}

/**
 * Maakt van gegevens een scriptblok met JSON-LD. Het teken < wordt vervangen, zodat tekst in de gegevens het blok nooit kan afsluiten.
 * @param {object[]} graphs De Schema.org-objecten (leeg = geen blok).
 * @returns {string} Het HTML-blok, of een lege tekst als er niets is.
 */
function jsonLdBlock(graphs) {
  const items = (graphs || []).filter(Boolean);
  if (!items.length) return '';
  const json = JSON.stringify(items.length === 1 ? items[0] : items).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
  return `<script type="application/ld+json">${json}</script>\n`;
}

/**
 * Splitst een adres als "Oenenburgweg 218, 8072 GP Nunspeet" in straat, postcode en plaats.
 * @param {string} address Het adres zoals het in Beheer staat.
 * @returns {{ streetAddress: string, postalCode?: string, addressLocality?: string }} De delen; bij een onbekende opmaak alleen de straat (de hele tekst).
 */
function splitAddress(address) {
  const match = /^(.*?),\s*(\d{4}\s?[A-Za-z]{2})\s+(.+)$/.exec(String(address || '').trim());
  return match ? { streetAddress: match[1].trim(), postalCode: match[2].trim(), addressLocality: match[3].trim() } : { streetAddress: String(address || '').trim() };
}

/**
 * Het telefoonnummer in internationale notatie (06 → +316).
 * @param {string} phone Het nummer zoals het getoond wordt.
 * @returns {string} Het nummer met landnummer, leeg zonder cijfers.
 */
function internationalPhone(phone) {
  const digits = String(phone || '').replace(/[^0-9+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  return digits.startsWith('0') ? `+31${digits.slice(1)}` : digits;
}

/**
 * De gegevens van het bedrijf (Schema.org Store, een LocalBusiness) en van de website met zoekfunctie.
 * @param {{ contact: object, footer: object }} site De inhoud uit Beheer (contactgegevens en tekst in de voet).
 * @param {string} baseUrl Het webadres van de shop, met een slash achteraan.
 * @param {string} shopName De naam van de shop.
 * @param {string} imageUrl Volledig adres van een afbeelding voor het bedrijf (leeg = geen).
 * @returns {object[]} Twee Schema.org-objecten: het bedrijf en de website.
 */
function organizationJsonLd(site, baseUrl, shopName, imageUrl = '') {
  const contact = site.contact || {};
  const address = splitAddress(contact.address);
  const store = {
    '@context': 'https://schema.org', '@type': 'Store', '@id': absoluteUrl(baseUrl, '#bedrijf'),
    name: shopName, legalName: 'AquaTech Service', url: baseUrl,
    ...(site.footer && site.footer.about ? { description: site.footer.about } : {}),
    ...(imageUrl ? { image: imageUrl } : {}),
    ...(contact.email ? { email: contact.email } : {}),
    ...(contact.phone ? { telephone: internationalPhone(contact.phone) } : {}),
    ...(address.streetAddress ? { address: { '@type': 'PostalAddress', ...address, addressCountry: 'NL' } } : {}),
    ...(contact.kvk ? { identifier: { '@type': 'PropertyValue', propertyID: 'KvK', value: contact.kvk } } : {}),
    areaServed: { '@type': 'Country', name: 'Nederland' },
  };
  const website = {
    '@context': 'https://schema.org', '@type': 'WebSite', '@id': absoluteUrl(baseUrl, '#website'), name: shopName, url: baseUrl, inLanguage: 'nl-NL',
    publisher: { '@id': store['@id'] },
    potentialAction: { '@type': 'SearchAction', target: { '@type': 'EntryPoint', urlTemplate: absoluteUrl(baseUrl, 'zoeken/?q={search_term_string}') }, 'query-input': 'required name=search_term_string' },
  };
  return [store, website];
}

/**
 * Het kruimelpad als Schema.org BreadcrumbList.
 * @param {{ name: string, path: string }[]} crumbs De stappen van de startpagina naar de pagina zelf (path = pad vanaf de startpagina).
 * @param {string} baseUrl Het webadres van de shop, met een slash achteraan.
 * @returns {object} Het Schema.org-object.
 */
function breadcrumbJsonLd(crumbs, baseUrl) {
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, index) => ({ '@type': 'ListItem', position: index + 1, name: crumb.name, item: absoluteUrl(baseUrl, crumb.path) })),
  };
}

/**
 * Een product met aanbieding (prijs incl. btw voor consumenten, voorraad) als Schema.org Product.
 * Een hoofdartikel met varianten krijgt een AggregateOffer (laagste en hoogste prijs).
 * @param {{ product: object, baseUrl: string, canonicalPath: string, shopName: string, description: string }} input product = uit de catalogus (code, name, priceIncl, inStock, image, categoryName, optioneel variants), canonicalPath = pad van de pagina, description = de tekst van de pagina.
 * @returns {object} Het Schema.org-object.
 */
function productJsonLd({ product, baseUrl, canonicalPath, shopName, description }) {
  const url = absoluteUrl(baseUrl, canonicalPath);
  const seller = { '@type': 'Organization', name: shopName };
  const variants = product.variants || [];
  const image = imageUrlOf(baseUrl, product.image);
  const offers = variants.length
    ? {
      '@type': 'AggregateOffer', priceCurrency: 'EUR', offerCount: variants.length, url,
      lowPrice: Math.min(...variants.map((variant) => variant.priceIncl)).toFixed(2), highPrice: Math.max(...variants.map((variant) => variant.priceIncl)).toFixed(2),
      availability: variants.some((variant) => variant.inStock) ? AVAILABILITY.in : AVAILABILITY.out, itemCondition: 'https://schema.org/NewCondition', seller,
    }
    : {
      '@type': 'Offer', priceCurrency: 'EUR', price: Number(product.priceIncl).toFixed(2), url,
      availability: product.inStock ? AVAILABILITY.in : AVAILABILITY.out, itemCondition: 'https://schema.org/NewCondition', seller,
    };
  return {
    '@context': 'https://schema.org', '@type': 'Product', name: product.name, sku: product.code, description,
    ...(image ? { image: [image] } : {}),
    ...(product.categoryName ? { category: product.categoryName } : {}),
    url, offers,
  };
}

/**
 * Haalt vragen en antwoorden uit de tekst van een pagina: elke kop (h2 tot en met h4) is een vraag, de tekst eronder tot de volgende kop het antwoord.
 * @param {string} bodyHtml De HTML van de pagina uit Beheer.
 * @returns {{ question: string, answer: string }[]} De vragen met antwoord (leeg als de pagina er geen heeft).
 */
function faqEntriesOf(bodyHtml) {
  const parts = String(bodyHtml || '').split(/<h[2-4][^>]*>/i).slice(1);
  /**
   * Maakt van een stuk HTML gewone tekst.
   * @param {string} html Het stuk HTML.
   * @returns {string} De tekst zonder tags, met één spatie tussen de woorden.
   */
  const textOf = (html) => html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
  return parts.map((part) => {
    const [heading, ...rest] = part.split(/<\/h[2-4]>/i);
    return { question: textOf(heading), answer: textOf(rest.join(' ')) };
  }).filter((entry) => entry.question && entry.answer);
}

/**
 * Vragen en antwoorden als Schema.org FAQPage.
 * @param {{ question: string, answer: string }[]} entries De vragen (zie faqEntriesOf).
 * @returns {?object} Het Schema.org-object, of null zonder vragen.
 */
function faqJsonLd(entries) {
  if (!entries.length) return null;
  return {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: entries.map((entry) => ({ '@type': 'Question', name: entry.question, acceptedAnswer: { '@type': 'Answer', text: entry.answer } })),
  };
}

/**
 * De tekst van robots.txt: crawlers van zoekmachines en AI-zoekers mogen de shop lezen, behalve de persoonlijke pagina's.
 * @param {string} baseUrl Het webadres van de shop, met een slash achteraan.
 * @returns {string} De inhoud van robots.txt.
 */
function robotsTxt(baseUrl) {
  const prefix = new URL(baseUrl).pathname;
  const rules = ['Allow: /', ...PRIVATE_PATHS.map((privatePath) => `Disallow: ${prefix}${privatePath}`)].join('\n');
  const named = ALLOWED_CRAWLERS.map((crawler) => `User-agent: ${crawler}`).join('\n');
  return `${named}\n${rules}\n\nUser-agent: *\n${rules}\n\nSitemap: ${absoluteUrl(baseUrl, 'sitemap.xml')}\n`;
}

/**
 * De sitemap in XML.
 * @param {{ path: string, lastModified?: string }[]} entries De pagina's (path = pad vanaf de startpagina, lastModified = datum JJJJ-MM-DD of leeg).
 * @param {string} baseUrl Het webadres van de shop, met een slash achteraan.
 * @returns {string} Het XML-document.
 */
function sitemapXml(entries, baseUrl) {
  const urls = entries.slice(0, MAX_SITEMAP_URLS).map((entry) => `  <url><loc>${escapeXml(absoluteUrl(baseUrl, entry.path))}</loc>${entry.lastModified ? `<lastmod>${escapeXml(entry.lastModified)}</lastmod>` : ''}</url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

/**
 * Alle pagina's voor de sitemap: startpagina, hoofdcategorieën, categorieën met producten, vaste pagina's, producten en varianten.
 * @param {{ catalog: object, pages: { slug: string }[] }} input catalog = de gepubliceerde catalogus (zie buildCatalog), pages = de vaste pagina's (zie infoPagesOf in storefront.js).
 * @returns {{ path: string, lastModified?: string }[]} De pagina's met pad vanaf de startpagina en (bij producten) de laatste wijziging.
 */
function sitemapEntriesOf({ catalog, pages }) {
  const entries = [{ path: '' }];
  for (const group of catalog.groups) entries.push({ path: `groep/${group.slug}/` });
  for (const category of catalog.categories) {
    if (!category.hidden && category.count > 0) entries.push({ path: `categorie/${category.slug}/` });
  }
  for (const page of pages) entries.push({ path: page.slug === 'over-ons' ? 'over-ons/' : `pagina/${page.slug}/` });
  for (const product of [...catalog.products, ...catalog.variantProducts]) entries.push({ path: `product/${product.slug}/`, lastModified: product.updatedAt || '' });
  return entries;
}

/**
 * llms.txt: een korte samenvatting in Markdown voor AI-zoekers, met wie we zijn en waar de belangrijkste pagina's staan.
 * @param {{ shopName: string, baseUrl: string, site: object, groups: object[], pages: { slug: string, title: string }[] }} input site = inhoud uit Beheer (contact, footer), groups = hoofdcategorieën uit de catalogus, pages = vaste pagina's.
 * @returns {string} De inhoud van llms.txt.
 */
function llmsTxt({ shopName, baseUrl, site, groups, pages }) {
  const contact = site.contact || {};
  const about = site.footer && site.footer.about ? site.footer.about : `${shopName} is de webshop van AquaTech Service.`;
  const details = [
    contact.address && `Adres: ${contact.address}`, contact.phone && `Telefoon: ${contact.phone}`, contact.email && `E-mail: ${contact.email}`, contact.kvk && `KvK: ${contact.kvk}`,
  ].filter(Boolean).map((line) => `- ${line}`);
  const categories = groups.map((group) => `- [${group.name}](${absoluteUrl(baseUrl, `groep/${group.slug}/`)}): ${group.count} ${group.count === 1 ? 'product' : 'producten'}${group.intro ? `. ${String(group.intro).replace(/<\/(p|li|h[1-6])>/gi, ' ').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)}` : ''}`);
  const information = pages.map((page) => `- [${page.title}](${absoluteUrl(baseUrl, page.slug === 'over-ons' ? 'over-ons/' : `pagina/${page.slug}/`)})`);
  return `# ${shopName}\n\n> ${about}\n\n## Bedrijf\n\n${details.join('\n')}\n\n## Productgroepen\n\n${categories.join('\n')}\n\n## Informatie\n\n${information.join('\n')}\n\n## Voor machines\n\n- [Sitemap](${absoluteUrl(baseUrl, 'sitemap.xml')})\n- [Productfeed](${absoluteUrl(baseUrl, 'productfeed.xml')})\n`;
}

/**
 * De productfeed voor Google Merchant Center (RSS 2.0 met g:-velden): elk artikel met foto, ook elke variant apart.
 * @param {{ shopName: string, baseUrl: string, products: object[], groups: object[] }} input products = uit de catalogus, groups = hoofdcategorieën (voor product_type).
 * @returns {string} Het XML-document.
 */
function merchantFeedXml({ shopName, baseUrl, products, groups }) {
  const groupName = new Map(groups.map((group) => [group.slug, group.name]));
  const items = [];
  /**
   * Zet één artikel in de feed (artikelen zonder foto worden overgeslagen, want Merchant Center eist een afbeelding).
   * @param {{ id: string, title: string, slug: string, image: string, priceIncl: number, inStock: boolean, product: object, groupId?: string }} entry Het artikel.
   * @returns {void}
   */
  const addItem = (entry) => {
    const image = imageUrlOf(baseUrl, entry.image);
    if (!image) return;
    const type = [groupName.get(entry.product.groupSlug), entry.product.categoryName].filter(Boolean).join(' > ');
    items.push(`    <item>
      <g:id>${escapeXml(entry.id)}</g:id>
      <title>${escapeXml(entry.title.slice(0, 150))}</title>
      <description>${escapeXml(`${entry.title} (artikelnummer ${entry.id}) van ${shopName}.`)}</description>
      <link>${escapeXml(absoluteUrl(baseUrl, `product/${entry.slug}/`))}</link>
      <g:image_link>${escapeXml(image)}</g:image_link>
      <g:availability>${entry.inStock ? 'in_stock' : 'out_of_stock'}</g:availability>
      <g:price>${Number(entry.priceIncl).toFixed(2)} EUR</g:price>
      <g:condition>new</g:condition>
      <g:identifier_exists>no</g:identifier_exists>${type ? `\n      <g:product_type>${escapeXml(type)}</g:product_type>` : ''}${entry.groupId ? `\n      <g:item_group_id>${escapeXml(entry.groupId)}</g:item_group_id>` : ''}
    </item>`);
  };
  for (const product of products) {
    if (product.variants && product.variants.length) {
      for (const variant of product.variants) {
        addItem({ id: variant.code, title: `${product.name} – ${variant.label}`, slug: variant.slug, image: variant.image || product.image, priceIncl: variant.priceIncl, inStock: variant.inStock, product, groupId: product.code });
      }
    } else {
      addItem({ id: product.code, title: product.name, slug: product.slug, image: product.image, priceIncl: product.priceIncl, inStock: product.inStock, product });
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n  <channel>\n    <title>${escapeXml(shopName)}</title>\n    <link>${escapeXml(baseUrl)}</link>\n    <description>${escapeXml(`Productfeed van ${shopName}`)}</description>\n${items.join('\n')}\n  </channel>\n</rss>\n`;
}

module.exports = {
  ALLOWED_CRAWLERS, PRIVATE_PATHS, escapeXml, absoluteUrl, imageUrlOf, jsonLdBlock, splitAddress, internationalPhone,
  organizationJsonLd, breadcrumbJsonLd, productJsonLd, faqEntriesOf, faqJsonLd, robotsTxt, sitemapEntriesOf, sitemapXml, llmsTxt, merchantFeedXml,
};
