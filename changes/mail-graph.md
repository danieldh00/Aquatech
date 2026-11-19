---
titel: Mail versturen via Microsoft 365 (Graph)
---

## Nieuws
- [beheer] Mail kan nu via Microsoft 365 (Graph) worden verstuurd in plaats van SMTP. Dat gaat over HTTPS, dus een geblokkeerde mailpoort bij de internetprovider is geen probleem meer. In Beheer > Instellingen > E-mail staat een stappenplan voor de app-registratie in Microsoft Entra, inclusief het beperken van de app tot één mailbox.

- [beheer] Graph-mail stel je automatisch in: je krijgt een Microsoft-code en -link, logt in als globale beheerder en de app maakt zelf de registratie, de machtiging en het geheim aan.
- [beheer] Een maand voordat het clientgeheim van de Graph-mail verloopt (en zodra het verlopen is) geeft Bewaking een melding.

## Changelog
- `platform/mail-graph.js`: Graph-verzender (client credentials, `Mail.Send` als toepassingsmachtiging, `sendMail` met `saveToSentItems`, bericht met bijlagen tot ongeveer 3,5 MB (base64), inline afbeeldingen via `contentId`); vaste hosts `login.microsoftonline.com` en `graph.microsoft.com`, tenant- en client-ID gevalideerd, token per (tenant, app, geheim) kort onthouden.
- `mailServer.mode` kent nu `graph` met `graphTenantId` en `graphClientId`; het clientgeheim is de versleutelde, `liveOnly` instelling `mailGraphSecret` (alleen via `/api/admin/mail`, veld `graphSecret`; `graphSecretSet` in het antwoord). Geen migratie.
- `mailFailure` kent EGRAPH_AUTH/DENIED/MAILBOX/THROTTLED/SIZE/ERROR met advies; de bewaking controleert het token (`verify`). Tests: `createApp({ graphFetch })`.
- `platform/mail-graph-setup.js`: automatische inrichting met de device code flow (inlog-client standaard de openbare Azure CLI-client, te vervangen met `GRAPH_SETUP_CLIENT_ID`; scopes Application.ReadWrite.All, AppRoleAssignment.ReadWrite.All, Organization.Read.All). Maakt (of hergebruikt) de app *AquaTech Hub mail*, de service principal, de app-roltoewijzing Mail.Send en een clientgeheim van 12 maanden. Het token van de beheerder wordt niet bewaard; het device-code blijft server-side; sessie gebonden aan omgeving en gebruiker; routes `/api/admin/mail/graph-setup` (start, poll, annuleren) met limieten en audit `mail_graph_ingericht`. Beperken tot één mailbox (Application Access Policy) kan niet via Graph en blijft een handmatige stap.
- `mailServer.graphSecretExpires` (JJJJ-MM-DD) en bewakingscontrole `mail-secret` (waarschuwing vanaf 30 dagen, fout bij verlopen, hint zonder datum).
