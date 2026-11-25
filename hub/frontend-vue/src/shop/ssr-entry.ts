// Ingang van de server-side tekenlaag van de webshop: de backend laadt dit gebouwde bestand en vraagt per pagina de schil.
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ShopShell from './ShopShell.vue'
import type { ShellProps } from './types'

/**
 * Tekent de schil (mededeling, kop, menu, voet) als HTML, met het commentaar `<!--shop-body-->` op de plek van de paginainhoud
 * in `<main>`. Vue zet hydratie-ankers en lege commentaren in de uitvoer; die zijn hier overbodig (de schil hydrateert niet) en gaan eruit.
 * @param shell De gegevens van de schil.
 * @returns De HTML van de schil.
 */
export async function renderShell(shell: ShellProps): Promise<string> {
  const html = await renderToString(createSSRApp(ShopShell, { shell }))
  return html.replace(/<!--\[-->|<!--\]-->|<!---->/g, '')
}
