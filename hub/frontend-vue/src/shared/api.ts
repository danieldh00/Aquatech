// Getypte API-client voor de Vue-modules. Gedraagt zich als de fetch-hulp van de oude modules: adressen relatief
// vanaf de modulemap (`../api/…` = /app/api/…), nooit uit de cache, JSON in en uit, en een fout met de melding van
// de server (of een leesbare melding bij de status) plus het veld en de foutcode als de server die meegeeft.
import { shellWindow } from './shell'

/** Fout van een API-aanroep met de gegevens die de server meegaf. */
export class ApiError extends Error {
  /** HTTP-status (0 bij een netwerkfout). */
  readonly status: number
  /** Veld in het formulier waar de fout bij hoort, als de server dat noemt. */
  readonly field: string | null
  /** Machineleesbare foutcode van de server (bijvoorbeeld `totp_required`). */
  readonly code: string | null

  /**
   * Maakt een API-fout.
   * @param message Leesbare melding voor de gebruiker.
   * @param status HTTP-status.
   * @param field Veldnaam of null.
   * @param code Foutcode of null.
   */
  constructor(message: string, status: number, field: string | null = null, code: string | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.field = field
    this.code = code
  }
}

/** Opties van een API-aanroep. */
export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
}

/** Terugvalmeldingen als de schil (shared/common.js) niet geladen is, bijvoorbeeld in tests. */
const FALLBACK_MESSAGES: Record<number, string> = {
  401: 'Je bent niet ingelogd.',
  403: 'Je hebt hier geen recht toe.',
  404: 'Niet gevonden.',
  409: 'Dit botst met een andere wijziging.',
  429: 'Te veel verzoeken, probeer het zo opnieuw.',
}

/**
 * Leesbare melding bij een HTTP-status, bij voorkeur van de schil.
 * @param status HTTP-status.
 * @returns De melding.
 */
export function statusMessage(status: number): string {
  const common = shellWindow().AquatechCommon
  if (common) return common.statusMessage(status)
  return FALLBACK_MESSAGES[status] || (status >= 500 ? 'De server geeft een fout. Probeer het zo opnieuw.' : `Het verzoek mislukte (status ${status}).`)
}

/**
 * Doet een verzoek aan de API.
 * @param path Pad onder api/, zonder begin-slash (bijvoorbeeld `customers?limit=50`).
 * @param options Methode en JSON-body.
 * @returns Het JSON-antwoord (een leeg object als de server geen JSON teruggeeft).
 * @throws {ApiError} Bij een netwerkfout of een antwoord dat niet ok is.
 */
export async function api<T = Record<string, unknown>>(path: string, { method = 'GET', body }: ApiOptions = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`../api/${path}`, {
      method,
      cache: 'no-store',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('Geen verbinding met de server. Controleer je internet en probeer het opnieuw.', 0)
  }
  const out = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const message = typeof out.message === 'string' && out.message ? out.message : statusMessage(response.status)
    throw new ApiError(message, response.status, typeof out.field === 'string' ? out.field : null, typeof out.code === 'string' ? out.code : null)
  }
  return out as T
}
