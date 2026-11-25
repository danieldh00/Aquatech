// Router voor een modulepagina. De adressen van de oude modules blijven werken: de pagina staat op de
// modulemap (`klanten/`), de weergave volgt uit de zoekparameters (`?id=…`, `?nieuw`) en tabbladen uit de #hash.
// De basis van de geschiedenis is de map van de huidige pagina, dus het werkt onder /app/ en achter elke proxy.
import { createRouter, createWebHistory, type Router, type RouteRecordRaw } from 'vue-router'
import type { Component } from 'vue'

/**
 * De map van de huidige pagina als basis van de router.
 * @param pathname Pad van de pagina (bijvoorbeeld `/app/klanten/` of `/app/klanten/index.html`).
 * @returns Het pad van de map, altijd eindigend op een slash.
 */
export function baseFromPath(pathname: string): string {
  const folder = pathname.replace(/[^/]*$/, '')
  return folder.endsWith('/') ? folder : `${folder}/`
}

/**
 * Maakt de router voor een modulepagina met één hoofdweergave.
 * @param view De component die alle weergaven van de module toont (hij kiest zelf op `route.query`).
 * @param pathname Pad van de pagina (standaard het huidige adres; een parameter voor tests).
 * @returns De router.
 */
export function createModuleRouter(view: Component, pathname: string = window.location.pathname): Router {
  const routes: RouteRecordRaw[] = [{ path: '/:rest(.*)*', component: view }]
  return createRouter({ history: createWebHistory(baseFromPath(pathname)), routes })
}
