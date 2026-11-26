---
titel: Artikelen overzichtelijker met subpagina's in de zijbalk
---

## Nieuws
- [voorraad] Artikelen is opgedeeld: in de zijbalk staan onder Artikelen nu subpagina's (Alle artikelen, Voorraad: Gereserveerd en Telling, Inhoud: Specificaties en teksten, Afbeeldingen en Past bij, Beheer: Import en export en Eenheden). De lijst zelf houdt alleen zoeken, filters, + Artikel en Excel-export; de overige knoppen staan op de pagina Import en export.

## Changelog
- Artikelen: tabbladen vervangen door subpagina's in de zijbalk (groep `artikelen`, `navSection` voor tussenkoppen Voorraad/Inhoud/Beheer in `shared/sidebar.js|.css`); de tabbalk blijft zichtbaar voor gebruikers zonder zijbalk.
- Nieuwe onderdelen `import` (Uit catalogus, Importeren uit Excel, Ontbrekende uit webshop toevoegen, Alles uit webshop, Afbeeldingen en miniaturen, Artikelen groeperen) en `units` (Eenheden) in `artikelen/`; de formulieren en dialogen staan nu in `#v-forms` buiten de tabbladen zodat ze overal werken.
- Knop "Samenvoegen tot variabel artikel" heet nu "Artikelen groeperen (subartikelen)". De hernoeming binnen code en database volgt apart.
- Geen migratie.
