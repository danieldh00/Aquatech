# Werkwijze (projectonafhankelijk)

Algemene afspraken voor samenwerken met Claude in een project met een coördinator en threads. Bevat geen productkennis: die staat per project in een eigen contextbestand (voor AquaTech Hub: `docs/AQUATECH-CONTEXT.md`).

**Onderhoud:** wie de werkwijze verandert, werkt dit bestand bij in dezelfde PR. De kopie in de projectbestanden (`werkwijze/WERKWIJZE.md`) blijft gelijk aan deze versie.

## Zo neem je dit mee naar een nieuw project
- **Claude Code op een repo:** kopieer dit bestand naar `docs/WERKWIJZE.md` in de nieuwe repo en gebruik `CLAUDE-sjabloon.md` als start van de `CLAUDE.md` (Claude Code leest die automatisch). Vul de projectspecifieke sectie in.
- **Claude-project (claude.ai) of andere omgeving:** plak de inhoud van dit bestand plus een korte projectcontext in de projectinstructies.
- Houd projectkennis (product, prijsregels, omgeving) gescheiden van dit bestand, zodat dit zonder aanpassing hergebruikt kan worden.

## Communicatie
- Nederlands, kort en zakelijk. Tijden in Europe/Amsterdam.
- Exports altijd als Excel (.xlsx), nooit CSV, tenzij daar expliciet om gevraagd wordt.
- Benoem items bij naam, niet alleen bij nummer.
- UX: zo min mogelijk handelingen voor de gebruiker; automatiseer op de achtergrond.
- Gebruik de term "KPI's" (niet "kengetallen" of "cijfers").
- Een antwoord begint met de uitkomst of de vraag; geen verslag van het werk eromheen.

## Coördinator en threads
- Eén thread per taak. De coördinator praat met de gebruiker, threads voeren uit.
- Een opdracht aan een thread is een gestructureerde brief: **Doel, Wat, Waar** (bestanden/paden), **Regels**, **Klaar als**, **Werkwijze**. Gericht en klein; geen brede verkenning.
- Een thread stopt na de merge. Vervolgvragen gaan naar de nog open thread, geen nieuwe.
- Overlap tussen threads vermijden: raken twee taken dezelfde bestanden, doe ze achter elkaar. Grote bestanden alleen opsplitsen als er geen ander werk loopt.
- Updates bundelen: niet bij elke stap een bericht, wel bij een resultaat, blokkade of vraag.
- Groot item: eerst een korte opzet (spec), dan pas bouwen.
- Bundel kleine taken in één thread.

## Niet wachten
- Wat op de gebruiker wacht, parkeren en doorgaan met de rest.
- Is een stap terug te draaien, doe hem en meld het. Alleen onomkeerbare stappen (productie, bulkverwijdering, bericht naar buiten) wachten op een go.

## Modelkeuze en verbruik
- Standaard Sonnet; een lichter model (Haiku) voor eenvoudig zoekwerk, tekst en kleine fixes.
- Zoeken, aanroepen vinden en tests draaien via kleine verkenners, zodat de hoofdsessie klein blijft; de hoofdsessie schrijft de code en beslist.
- Lokaal eerst alleen de geraakte tests; pas daarna pushen. Een falende run herhaal je alleen voor wat faalde.
- Werk in een draft-PR en zet hem pas op ready als het klaar is.

## Code en PR's
- Nooit rechtstreeks op de hoofdbranch; branch vers vanaf de hoofdbranch.
- Kleine PR's, één onderwerp. Releasenotes-fragment per wijziging in de applicatiecode; versienummers en changelog nooit met de hand.
- Auto-merge pas als CI en de verplichte reviews groen zijn **en** de reviewopmerkingen op de huidige head gelezen en verwerkt zijn (een groene review kan nog open bevindingen hebben). Faalt een review op limieten, draai hem opnieuw.
- Databasemigraties zijn positioneel: neem bij het mergen het eerstvolgende vrije nummer op de hoofdbranch en rebase vlak voor de merge. Er lopen vaak meerdere threads tegelijk.
- Tests voor randgevallen; dezelfde database als productie in de tests.
- UI controleren op 1440 en 375 px via DOM/CSS-meting; geen screenshots tenzij gevraagd.
- Eén diepe beveiligingsscan vóór go-live.
- Geen modelnamen of -ID's in commits, PR's, code of docs. Nooit secrets, wachtwoorden of persoonsgegevens in repo, chat of geheugen (zeker niet in een publieke repo).
- Een nieuwe externe koppeling: instelling in de app, status en logboek zichtbaar, nooit tokens in de uitvoer.

## Servertaken en scripts
- Geef de gebruiker nooit losse servercommando's in de chat. Heeft een wijziging iets op de server nodig, voeg dan een servertaak toe die als afvinklijst in de app verschijnt (alleen zichtbaar als er iets openstaat).
- Eén vast commando draait alles, als root op de hypervisor-host (Proxmox). Gastmachines hebben root-login uit, dus scripts gaan via ssh als gewone gebruiker + sudo.
- Ruwe bestanden van GitHub altijd op een vaste commit-SHA, nooit op een branch.
- Thuisverbinding bij een consumentenprovider: uitgaande poort 25 is waarschijnlijk geblokkeerd; mail via een API (bijv. Microsoft Graph) of poort 587.
- Back-ups instelbaar en zichtbaar in de app, met optioneel een externe kopie.

## Projectbestanden en overzichten
- Doorlichtingen, takenlijsten en rapporten als Excel in de projectbestanden, met een statuskolom die threads bijwerken.
- Een bijgehouden wachtlijst/overzicht wordt bij elke wijziging in de wachtrij bijgewerkt door de coördinator.
- Houd het projectgeheugen compact: durable afspraken en lopend werk, geen lijsten met afgeronde PR's.
