// Brug naar de bestaande schil: de gewone scripts van hub/frontend/shared (common.js, address-lookup.js,
// excel-import.js, doc-text.js) hangen hun functies aan `window`. Hier staan hun types en een paar veilige
// toegangsfuncties, zodat Vue-componenten nooit zelf op `window` hoeven te grijpen en tests de schil kunnen nabootsen.

/** Gegevens van de ingelogde gebruiker uit api/me (alleen wat Vue-modules nodig hebben). */
export interface Me {
  rights?: string[]
  [key: string]: unknown
}

/** De functies van shared/common.js die modules gebruiken. */
export interface CommonShell {
  getJson: <T = unknown>(path: string, options?: { fresh?: boolean }) => Promise<T>
  excel: () => Promise<ExcelLibrary>
  statusMessage: (status: number) => string
  onReturn: (callback: () => void) => void
}

/** Het deel van ExcelJS dat modules gebruiken. */
export interface ExcelLibrary {
  Workbook: new () => ExcelWorkbook
}

/** Een ExcelJS-werkmap (alleen de gebruikte delen). */
export interface ExcelWorkbook {
  addWorksheet: (name: string) => ExcelSheet
  xlsx: { writeBuffer: () => Promise<ArrayBuffer> }
}

/** Een ExcelJS-werkblad (alleen de gebruikte delen). */
export interface ExcelSheet {
  columns: { header: string; key: string; width: number }[]
  addRow: (row: Record<string, unknown>) => void
  getRow: (index: number) => { font: Record<string, unknown> }
  views: Record<string, unknown>[]
}

/** shared/address-lookup.js: postcodezoeker die boven een adresveld komt. */
export interface AddressLookupShell {
  enhance: (field: HTMLTextAreaElement | HTMLInputElement) => HTMLElement | null
  mirror: (field: HTMLTextAreaElement | HTMLInputElement, element: Element) => () => void
}

/** Opties voor het Excel-importvenster van shared/excel-import.js. */
export interface ExcelImportOptions {
  title: string
  subject: string
  keyLabel: string
  templateName: string
  api: (path: string, options?: { method?: string; body?: unknown }) => Promise<unknown>
  intro: string
  fieldsPath: string
  importPath: string
  onDone: () => void
}

/** shared/excel-import.js. */
export interface ExcelImportShell {
  open: (options: ExcelImportOptions) => void
}

/** shared/doc-text.js (alleen de taalkeuzes). */
export interface DocTextShell {
  LANGUAGES: Record<string, string>
}

/** Alles wat de schil op `window` zet. */
export interface ShellWindow {
  AquatechCommon?: CommonShell
  AddressLookup?: AddressLookupShell
  AquatechExcelImport?: ExcelImportShell
  DocText?: DocTextShell
}

/**
 * Geeft het venster met de schil-onderdelen.
 * @returns Het venster, getypt als schilvenster.
 */
export function shellWindow(): ShellWindow {
  return window as unknown as ShellWindow
}

/**
 * Haalt api/me op via de gedeelde, per pagina gecachte aanvraag van de schil.
 * @returns De gebruiker, of null als de schil ontbreekt of het ophalen mislukt.
 */
export async function loadMe(): Promise<Me | null> {
  const common = shellWindow().AquatechCommon
  if (!common) return null
  try {
    return await common.getJson<Me>('api/me')
  } catch {
    return null
  }
}

/**
 * Of de ingelogde gebruiker een recht heeft (alleen voor het verbergen van knoppen; de server dwingt af).
 * @param me De gebruiker uit {@link loadMe}.
 * @param right Het recht, bijvoorbeeld "beheer".
 * @returns true als het recht in de lijst staat.
 */
export function hasRight(me: Me | null, right: string): boolean {
  return Boolean(me && Array.isArray(me.rights) && me.rights.includes(right))
}
