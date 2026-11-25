// Een HTML-commentaar als component: de backend vervangt zulke markeringen na het tekenen (inhoud van de pagina, planner-link).
import { createCommentVNode, defineComponent } from 'vue'

export default defineComponent({
  name: 'ShopMarker',
  props: { text: { type: String, required: true } },
  /** Tekent `<!--tekst-->`. */
  setup(props) {
    return () => createCommentVNode(props.text)
  },
})
