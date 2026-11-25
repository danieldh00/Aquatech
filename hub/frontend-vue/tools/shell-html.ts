// Vite-plugin die de bestaande schil (CSS, common.js en gewone scripts van hub/frontend/shared, dashboard enz.) in elke
// modulepagina zet. De schil staat niet in dit project maar naast de module in het uiteindelijke image
// (frontend/shared/…), dus Vite mag die adressen niet zelf proberen te bundelen: ze worden pas ná de
// bundeling als vaste tekst ingevoegd, op de plaats van twee markeringen in de index.html van de module.
import type { Plugin } from 'vite'

/** Markering in de <head> waar de schil-stijlbladen komen. */
export const HEAD_MARKER = '<!--@schil-stijlen-->'
/** Markering onderaan de <body> waar de gewone schil-scripts komen. */
export const SCRIPT_MARKER = '<!--@schil-scripts-->'

/** Stijlbladen van de schil, relatief vanaf een modulemap (zelfde volgorde als de oude pagina's). */
export const SHELL_STYLES = [
  '../shared/brand.css',
  '../shared/theme.css',
  '../shared/sidebar.css',
  '../dashboard/dashboard.css',
  '../beheer/beheer.css',
  '../shared/layout.css',
  '../shared/excel-import.css',
]

/** Gewone scripts in de <head> (common.js geeft de pagina `AquatechCommon` en moet dus vóór de module klaar zijn). */
export const SHELL_HEAD_SCRIPTS = ['../shared/common.js']

/** Gewone scripts van de schil die vóór de module draaien (zijbalk, rekeningmenu, adreszoeker, Excel-import, teksten). */
export const SHELL_SCRIPTS = [
  '../shared/env.js',
  '../dashboard/modules.js',
  '../shared/sidebar.js',
  '../dashboard/account.js',
  '../shared/address-lookup.js',
  '../shared/doc-text.js',
  '../shared/excel-import.js',
]

/**
 * Vervangt de twee schilmarkeringen in een HTML-tekst door de echte tags.
 * @param html De HTML van een modulepagina.
 * @returns De HTML met de stijlbladen en scripts van de schil.
 */
export function injectShell(html: string): string {
  const styles = [
    ...SHELL_STYLES.map((href) => `<link rel="stylesheet" href="${href}">`),
    ...SHELL_HEAD_SCRIPTS.map((src) => `<script src="${src}"></script>`),
  ].join('\n  ')
  const scripts = SHELL_SCRIPTS.map((src) => `<script src="${src}"></script>`).join('\n  ')
  return html.replace(HEAD_MARKER, styles).replace(SCRIPT_MARKER, scripts)
}

/**
 * Maakt de Vite-plugin die {@link injectShell} na de bundeling uitvoert.
 * @returns De plugin.
 */
export function shellHtmlPlugin(): Plugin {
  return {
    name: 'aquatech-schil-html',
    transformIndexHtml: { order: 'post', handler: (html: string) => injectShell(html) },
  }
}
