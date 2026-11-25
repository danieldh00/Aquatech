// Melding onderin beeld (3,5 s), gedeeld door alle componenten van een pagina. De weergave staat in ToastHost.vue
// en gebruikt dezelfde CSS-klassen (`.toast`, `.toast.show`, `.toast.err`) als de oude modules.
import { reactive, readonly } from 'vue'

/** Hoe lang een melding zichtbaar blijft (ms). */
export const TOAST_DURATION_MS = 3500

const state = reactive({ message: '', isError: false, visible: false })
let timer: ReturnType<typeof setTimeout> | undefined

/**
 * Toont een melding onderin beeld.
 * @param message De melding.
 * @param isError true = foutmelding (rood).
 */
export function showToast(message: string, isError = false): void {
  state.message = message
  state.isError = isError
  state.visible = true
  clearTimeout(timer)
  timer = setTimeout(() => { state.visible = false }, TOAST_DURATION_MS)
}

/**
 * De huidige melding, alleen-lezen, voor de weergave.
 * @returns De reactieve stand van de melding.
 */
export function useToastState() {
  return readonly(state)
}
