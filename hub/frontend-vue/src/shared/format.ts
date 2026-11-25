// Opmaak van bedragen en datums zoals de oude modules (Nederlandse notatie).

/**
 * Bedrag in euro's.
 * @param value Het bedrag (alles wat geen getal is telt als 0).
 * @returns Bijvoorbeeld "€ 1.234,50".
 */
export function formatEuro(value: unknown): string {
  return (Number(value) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' })
}

/**
 * Datum kort in het Nederlands.
 * @param iso Datum (JJJJ-MM-DD) of een volledig tijdstip.
 * @returns Bijvoorbeeld "22-10-2026" (leeg zonder datum).
 */
export function formatShortDate(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('nl-NL')
}
