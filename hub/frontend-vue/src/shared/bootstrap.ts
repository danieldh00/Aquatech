// Start van een modulepagina: Vue-app met router op het element `#app` van de index.html van de module.
import { createApp, type Component } from 'vue'
import { createModuleRouter } from './router'

/**
 * Start de module.
 * @param view De hoofdcomponent van de module (kiest zelf de weergave uit de zoekparameters).
 * @param selector Waar de app komt (standaard `#app`).
 * @returns Wanneer de eerste weergave klaar is.
 */
export async function mountModule(view: Component, selector = '#app'): Promise<void> {
  const router = createModuleRouter(view)
  const app = createApp(view)
  app.use(router)
  await router.isReady()
  app.mount(selector)
}
