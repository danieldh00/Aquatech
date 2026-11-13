---
titel: Orderpick-scherm voor het magazijn
---

## Nieuws
- [orderpick] Nieuw scherm *Orderpick* voor het magazijn: kies een bestelling, loop de regels af op volgorde van locatie en scan elk artikel met een scanner of de camera. Groen is goed, rood met trillen is fout. Het aantal staat al ingevuld; bevestig met OK of meld *Niet aanwezig*.
- [orderpick] Met *Order gepickt* gaat de bestelling weg met wat er echt gepickt is (de rest blijft op backorder), en maak je meteen de pakbon en, zodra de DPD-koppeling er is, het verzendlabel.

## Changelog
Orderpick deel 2: het scherm (geen migratie).

- `frontend/orderpick/`: lijst, scannen (toetsenbordscanner of camera met `BarcodeDetector`), aantal met OK en +/−, *Niet aanwezig*, afmelden met pakbon en label, voortgang en *Net gepickt* op het toestel.
- Rekenkern `orderpick-core.js` met unittests (`test/orderpick-core.test.js`).
- Module Orderpick in de groep Magazijn van de zijbalk en het dashboard (recht `orderpick`).
