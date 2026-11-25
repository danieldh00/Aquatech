// Gegevens die de webshopschil (kop, menu, voet) nodig heeft: gewone, JSON-vriendelijke waarden die de backend zelf opbouwt
// uit de inhoud van Beheer en de stand van de bezoeker. Geen HTML, geen functies: Vue ontsnapt alles bij het tekenen.

/** Eén categorie in het menu, met zijn zichtbare subcategorieën (al zonder verborgen categorieën). */
export interface MenuCategory {
  slug: string
  name: string
  children: MenuCategory[]
}

/** Een hoofdcategorie (kop in het menu) met zijn zichtbare categorieën. */
export interface MenuGroup {
  name: string
  categories: MenuCategory[]
}

/** Een link met een zichtbare titel. */
export interface ShellLink {
  href: string
  title: string
}

/** Alles wat de schil van één pagina nodig heeft. */
export interface ShellProps {
  /** Relatief pad naar de shop-startpagina ('', '../' of '../../'). */
  root: string
  /** Of de inhoud over de volle breedte staat (startpagina). */
  wide: boolean
  /** De ingevulde zoekterm. */
  query: string
  /** Versiesuffix voor bestanden onder assets/ (bijvoorbeeld '1.33.0'). */
  assetVersion: string
  notice: { enabled: boolean, text: string, color: string }
  contact: { phone: string, phoneHref: string, email: string, kvk: string, address: string }
  visitor: { ordering: boolean, cartCount: number, business: boolean, staff: boolean, wholesale: boolean, measuring: boolean }
  menu: { aboutLinks: ShellLink[], groups: MenuGroup[], extraPages: ShellLink[] }
  footer: { about: string, pages: ShellLink[], legal: ShellLink[] }
}
