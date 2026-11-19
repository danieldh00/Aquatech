---
titel: Duidelijkere mailfouten bij de testmail
---

## Nieuws
- [beheer] Als de testmail of een andere mail niet lukt, noemt de melding nu de mailserver en poort en zegt ze wat er mis is: geen antwoord (vaak een geblokkeerde poort), geweigerde verbinding of onbekende servernaam.

## Changelog
- `mailFailure` onderscheidt time-out, geweigerd (ECONNREFUSED), DNS-fout en geen route; `createMailer` legt host en poort vast op de fout (`mailHost`, `mailPort`; nooit het wachtwoord).
- `netguard.publicAddress` geeft bij meerdere adressen het IPv4-adres voorrang, zodat een container zonder IPv6 niet vastloopt op een IPv6-adres.
- `deploy/apps01/pve/diagnose-mail.sh`: alleen-lezen test van poort 25/465/587 vanaf de Proxmox-host, apps01 en de app-container.
