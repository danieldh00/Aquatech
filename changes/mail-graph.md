---
titel: Mail versturen via Microsoft 365 (Graph)
---

## Nieuws
- [beheer] Mail kan nu via Microsoft 365 (Graph) worden verstuurd in plaats van SMTP. Dat gaat over HTTPS, dus een geblokkeerde mailpoort bij de internetprovider is geen probleem meer. In Beheer > Instellingen > E-mail staat een stappenplan voor de app-registratie in Microsoft Entra, inclusief het beperken van de app tot één mailbox.

## Changelog
- `platform/mail-graph.js`: Graph-verzender (client credentials, `Mail.Send` als toepassingsmachtiging, `sendMail` met `saveToSentItems`, bericht met bijlagen tot ongeveer 3,5 MB (base64), inline afbeeldingen via `contentId`); vaste hosts `login.microsoftonline.com` en `graph.microsoft.com`, tenant- en client-ID gevalideerd, token per (tenant, app, geheim) kort onthouden.
- `mailServer.mode` kent nu `graph` met `graphTenantId` en `graphClientId`; het clientgeheim is de versleutelde, `liveOnly` instelling `mailGraphSecret` (alleen via `/api/admin/mail`, veld `graphSecret`; `graphSecretSet` in het antwoord). Geen migratie.
- `mailFailure` kent EGRAPH_AUTH/DENIED/MAILBOX/THROTTLED/SIZE/ERROR met advies; de bewaking controleert het token (`verify`). Tests: `createApp({ graphFetch })`.
