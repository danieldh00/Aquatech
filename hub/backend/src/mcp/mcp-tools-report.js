// De MCP-tool voor rapporten als Excel: maak_rapport_excel (zie mcp-tools.js voor het geheel en mcp-downloads.js voor de download).
const { REPORT_RIGHTS, MAX_REPORT_DAYS, cleanText, round2, resultOf, errorOf } = require('./mcp-tool-helpers');
const { buildWorkbook } = require('./xlsx-writer');

/**
 * Maakt de tools van dit onderdeel.
 * @param { ctx, withinLimit, articlesOf, maxRows, reportsPerHour } shared Wat mcp-tools.js deelt: de context van de server, de begrenzers en de hulpfuncties.
 * @returns { [name: string]: object } De tools (naam → scope, rechten, definitie en run).
 */
function createReportTools(shared) {
  const { ctx, withinLimit, articlesOf, maxRows, reportsPerHour } = shared;
  return {
  maak_rapport_excel: {
    scope: 'rapporten.excel', rights: ['werkorders', 'facturen', 'voorraad'],
    definition: {
      title: 'Rapport als Excel',
      description: 'Maakt een rapport als Excel-bestand (.xlsx) en geeft een downloadlink. De link werkt 15 minuten, alleen voor deze gebruiker en alleen als hij in AquaTech is ingelogd; '
        + 'geef de link aan de gebruiker, open hem niet zelf. Soorten: urenstaat (uren en materiaalverbruik over een periode van hooguit 400 dagen; met het recht planning van iedereen, anders alleen de eigen regels), '
        + 'openstaande_facturen (alle definitieve, onbetaalde facturen per klant) en voorraadlijst (artikelen met prijs en beschikbare voorraad). Er is geen CSV.',
      inputSchema: {
        type: 'object',
        properties: {
          soort: { type: 'string', enum: Object.keys(REPORT_RIGHTS) },
          van: { type: 'string', description: 'Urenstaat: eerste datum (JJJJ-MM-DD).' },
          tot: { type: 'string', description: 'Urenstaat: laatste datum (JJJJ-MM-DD).' },
        },
        required: ['soort'], additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    /**
     * Bouwt het rapport en zet het klaar voor download.
     * @param {object} args { soort, van, tot }.
     * @param {object} req Het verzoek.
     * @returns {object} De uitkomst met de link.
     */
    run: (args, req) => {
      if (!withinLimit(reportsPerHour, req)) return errorOf('Te veel rapporten dit uur via de AI-koppeling. Probeer het later opnieuw of maak het rapport in AquaTech.');
      const kind = Object.prototype.hasOwnProperty.call(REPORT_RIGHTS, args.soort) ? args.soort : '';
      if (!kind) return errorOf(`Kies de soort rapport: ${Object.keys(REPORT_RIGHTS).join(', ')}.`);
      if (!ctx.can(req.user, REPORT_RIGHTS[kind])) return errorOf('Je mag dit rapport in AquaTech niet bekijken.');
      const day = ctx.today();
      let sheets;
      let fileName;
      let summary;
      let truncated = false;
      if (kind === 'urenstaat') {
        /**
         * Of de tekst een bestaande datum (JJJJ-MM-DD) is.
         * @param {string} value De tekst.
         * @returns {boolean} true bij een geldige datum.
         */
        const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
        const from = cleanText(args.van, 10) || `${day.slice(0, 8)}01`;
        const to = cleanText(args.tot, 10) || day;
        if (!isDay(from) || !isDay(to) || from > to) return errorOf('Geef een geldige periode (van en tot als JJJJ-MM-DD, van niet na tot).');
        if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 > MAX_REPORT_DAYS) return errorOf(`Kies een periode van hooguit ${MAX_REPORT_DAYS} dagen.`);
        const userId = ctx.can(req.user, 'planning') ? null : req.user.id;
        const log = ctx.periodLog(req, { from, to, userId, limit: maxRows + 1 });
        const { hourCount, minutes, materialCount } = log.totals;
        truncated = hourCount > maxRows || materialCount > maxRows;
        log.hours = log.hours.slice(0, maxRows);
        log.materials = log.materials.slice(0, maxRows);
        sheets = [
          { name: 'Uren', columns: [
            { header: 'Datum', key: 'datum', type: 'date', width: 12 }, { header: 'Medewerker', key: 'medewerker', width: 22 }, { header: 'Werkorder', key: 'werkorder', width: 14 },
            { header: 'Klant', key: 'klant', width: 24 }, { header: 'Soort', key: 'soort', width: 12 }, { header: 'Begin', key: 'begin', width: 8 }, { header: 'Eind', key: 'eind', width: 8 },
            { header: 'Pauze (min)', key: 'pauze', type: 'number', width: 11 }, { header: 'Uren', key: 'uren', type: 'number', width: 8 }, { header: 'Notitie', key: 'notitie', width: 30 }],
          rows: log.hours.map((entry) => ({ datum: entry.workDate, medewerker: entry.user.displayName, werkorder: entry.workOrder ? entry.workOrder.number : '', klant: entry.workOrder ? entry.workOrder.customer : '',
            soort: entry.kind, begin: entry.startTime || '', eind: entry.endTime || '', pauze: entry.breakMinutes, uren: round2(entry.minutes / 60), notitie: entry.note || '' })) },
          { name: 'Materiaal', columns: [
            { header: 'Datum', key: 'datum', type: 'date', width: 12 }, { header: 'Medewerker', key: 'medewerker', width: 22 }, { header: 'Werkorder', key: 'werkorder', width: 14 },
            { header: 'Klant', key: 'klant', width: 24 }, { header: 'Artikelcode', key: 'code', width: 14 }, { header: 'Omschrijving', key: 'omschrijving', width: 32 },
            { header: 'Eenheid', key: 'eenheid', width: 9 }, { header: 'Aantal', key: 'aantal', type: 'number', width: 9 }, { header: 'Notitie', key: 'notitie', width: 30 }],
          rows: log.materials.map((entry) => ({ datum: entry.usedOn, medewerker: entry.user.displayName, werkorder: entry.workOrder ? entry.workOrder.number : '', klant: entry.workOrder ? entry.workOrder.customer : '',
            code: entry.code || '', omschrijving: entry.description || '', eenheid: entry.unit || '', aantal: entry.qty, notitie: entry.note || '' })) },
        ];
        fileName = `urenstaat-${from}-${to}`;
        summary = { periode: { van: from, tot: to }, aantalUrenregels: hourCount, totaalUren: round2(minutes / 60),
          aantalMateriaalregels: materialCount, alleenEigenRegels: Boolean(userId) };
      } else if (kind === 'openstaande_facturen') {
        const { rows, truncated: tooMany } = ctx.openInvoiceRows(req, maxRows);
        truncated = tooMany;
        sheets = [{ name: 'Openstaand', columns: [
          { header: 'Klant', key: 'klant', width: 28 }, { header: 'Nummer', key: 'nummer', width: 14 }, { header: 'Soort', key: 'soort', width: 12 }, { header: 'Datum', key: 'datum', type: 'date', width: 12 },
          { header: 'Vervaldatum', key: 'vervaldatum', type: 'date', width: 12 }, { header: 'Dagen te laat', key: 'dagen', type: 'number', width: 12 }, { header: 'Bedrag incl. btw', key: 'bedrag', type: 'money', width: 16 }],
        rows: rows.map((invoice) => ({ klant: invoice.klant, nummer: invoice.nummer, soort: invoice.soort, datum: invoice.datum, vervaldatum: invoice.vervaldatum, dagen: invoice.dagenTeLaat, bedrag: invoice.bedragInclBtw })) }];
        fileName = `openstaande-facturen-${day}`;
        summary = { aantalFacturen: rows.length, totaalOpenstaand: tooMany ? ctx.openInvoices(req, { limit: 1 }).totaalOpenstaand : round2(rows.reduce((sum, invoice) => sum + Number(invoice.bedragInclBtw || 0), 0)) };
      } else {
        const rows = [];
        for (const article of articlesOf(req.tenantId)) {
          if (rows.length >= maxRows) { truncated = true; break; }
          const variants = Array.isArray(article.variants) ? article.variants : [];
          if (variants.length) {
            for (const variant of variants) rows.push({ code: variant.code, naam: `${article.name} ${Object.values(variant.values || {}).join(' ')}`.trim(), eenheid: article.unit || 'st', prijs: variant.salePrice, btw: article.vatRate, beschikbaar: variant.available });
          } else rows.push({ code: article.code, naam: article.name, eenheid: article.unit || 'st', prijs: article.salePrice, btw: article.vatRate, beschikbaar: article.available });
        }
        if (rows.length > maxRows) { rows.length = maxRows; truncated = true; }
        sheets = [{ name: 'Voorraad', columns: [
          { header: 'Code', key: 'code', width: 16 }, { header: 'Naam', key: 'naam', width: 40 }, { header: 'Eenheid', key: 'eenheid', width: 9 },
          { header: 'Prijs excl. btw', key: 'prijs', type: 'money', width: 15 }, { header: 'Btw %', key: 'btw', type: 'number', width: 8 }, { header: 'Beschikbaar', key: 'beschikbaar', type: 'number', width: 12 }], rows }];
        fileName = `voorraadlijst-${day}`;
        summary = { aantalArtikelen: rows.length };
      }
      const stored = ctx.storeReport(req, fileName, buildWorkbook(sheets));
      if (stored.error === 'te_groot') return errorOf('Het rapport is te groot om klaar te zetten. Kies een kortere periode of een kleiner rapport.');
      if (stored.error) return errorOf('Het rapport kon nu niet klaargezet worden. Probeer het over een paar minuten opnieuw.');
      ctx.audit(req, 'rapport_via_ai', { soort: kind, via: 'ai-koppeling' });
      return resultOf({ status: 'klaar', soort: kind, ...summary, bestand: stored.fileName, downloadLink: stored.url, geldigTot: new Date(stored.expiresAt).toISOString(),
        ...(truncated ? { afgekapt: true, waarschuwing: `Het rapport bevat hoogstens ${maxRows} regels per tabblad; er zijn er meer. Zeg dat tegen de gebruiker en kies bij een urenstaat een kortere periode.` } : {}),
        let_op: 'Geef de link aan de gebruiker; hij moet in AquaTech ingelogd zijn en de link werkt 15 minuten.' });
    },
  },
  };
}

module.exports = { createReportTools };
