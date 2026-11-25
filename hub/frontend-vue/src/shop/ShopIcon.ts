// Pictogrammen van de webshopschil als Vue-component: dezelfde inline SVG als de oude schil, getekend uit gegevens.
import { defineComponent, h, type PropType } from 'vue'

/** Naam van een pictogram. */
export type IconName = 'search' | 'cart' | 'user' | 'menu' | 'phone' | 'admin'

/** Vormen per pictogram: [element, kenmerken]. */
const SHAPES: Record<IconName, Array<[string, Record<string, string>]>> = {
  search: [['circle', { cx: '11', cy: '11', r: '7' }], ['path', { d: 'm20 20-4-4' }]],
  cart: [['path', { d: 'M3 4h2l2.2 10.4a1 1 0 0 0 1 .8h8.6a1 1 0 0 0 1-.8L19.5 8H6' }], ['circle', { cx: '9.5', cy: '19', r: '1.3' }], ['circle', { cx: '17', cy: '19', r: '1.3' }]],
  user: [['circle', { cx: '12', cy: '8', r: '4' }], ['path', { d: 'M4 20c1.2-3.6 4.2-5 8-5s6.8 1.4 8 5' }]],
  menu: [['path', { d: 'M4 7h16M4 12h16M4 17h16' }]],
  phone: [['path', { d: 'M4 14v-2a8 8 0 0 1 16 0v2' }], ['rect', { x: '3', y: '13', width: '4', height: '6', rx: '1.5' }], ['rect', { x: '17', y: '13', width: '4', height: '6', rx: '1.5' }], ['path', { d: 'M19 19c0 1.5-1.5 2-4 2' }]],
  admin: [['path', { d: 'M4 13a8 8 0 0 1 16 0' }], ['path', { d: 'm12 13 4-5' }], ['circle', { cx: '12', cy: '13', r: '1.4' }], ['path', { d: 'M4 13v4h16v-4' }]],
}

export default defineComponent({
  name: 'ShopIcon',
  props: { name: { type: String as PropType<IconName>, required: true } },
  /** Tekent de SVG van het gevraagde pictogram. */
  setup(props) {
    return () => h('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, SHAPES[props.name].map(([tag, attributes]) => h(tag, attributes)))
  },
})
