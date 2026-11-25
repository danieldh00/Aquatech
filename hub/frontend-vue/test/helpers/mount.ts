// Hulp voor componenttests: monteert een component met een router in het geheugen en geeft de router terug.
import { afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter, type Router } from 'vue-router'
import { defineComponent, h, type Component } from 'vue'

/** Een lege weergave, voor routes waarvan alleen de URL telt. */
const EmptyView = defineComponent({ render: () => h('div') })

/** Alle in deze test gemonteerde wrappers; ze worden na elke test opgeruimd. */
const mounted: VueWrapper[] = []

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
})

/**
 * Monteert een component met een router in het geheugen.
 * @param component De component.
 * @param options Eigenschappen en het beginadres.
 * @returns De wrapper en de router.
 */
export async function mountWithRouter(component: Component, options: { props?: Record<string, unknown>; url?: string } = {}) {
  const router: Router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)*', component: EmptyView }] })
  await router.push(options.url ?? '/')
  await router.isReady()
  const wrapper = mount(component, { props: options.props, global: { plugins: [router] }, attachTo: document.body })
  mounted.push(wrapper)
  await flushPromises()
  return { wrapper, router }
}
