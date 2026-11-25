// Tests van de router-basis: de map van de pagina, ook achter een voorvoegsel.
import { describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { baseFromPath, createModuleRouter } from '@/shared/router'

describe('baseFromPath', () => {
  it('neemt de map van de pagina', () => {
    expect(baseFromPath('/app/klanten/')).toBe('/app/klanten/')
    expect(baseFromPath('/app/klanten/index.html')).toBe('/app/klanten/')
    expect(baseFromPath('/klanten/')).toBe('/klanten/')
    expect(baseFromPath('/')).toBe('/')
  })
})

describe('createModuleRouter', () => {
  it('laat de zoekparameters van de oude adressen werken', async () => {
    const view = defineComponent({ render: () => h('div') })
    const router = createModuleRouter(view, '/app/klanten/')
    await router.push('/?id=abc')
    expect(router.currentRoute.value.query.id).toBe('abc')
    await router.push('/?nieuw')
    expect(router.currentRoute.value.query).toHaveProperty('nieuw')
  })
})
