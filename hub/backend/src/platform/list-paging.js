// Gedeelde paginering voor lijsten (offertes, werkorders): een harde bovengrens en ?limit/?offset, zodat een lijst bij veel gegevens niet de hele omgeving leest (audit T-05).

const LIST_LIMIT = 2000;

/**
 * Het aantal rijen per pagina, begrensd tot 1 en LIST_LIMIT.
 * @param {*} value De gevraagde waarde (limit uit de URL of een standaard).
 * @returns {number} Een geheel getal tussen 1 en LIST_LIMIT.
 */
const pageSize = (value) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number >= 1 ? Math.min(number, LIST_LIMIT) : LIST_LIMIT;
};

/**
 * De startpositie van een pagina (geheel getal, minimaal 0).
 * @param {*} value De gevraagde waarde (offset uit de URL).
 * @returns {number} De startpositie.
 */
const pageOffset = (value) => {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
};

/**
 * Leest limit en offset uit de querystring van een verzoek.
 * @param {object} query req.query.
 * @returns {{ limit: number, offset: number }} De pagina.
 */
const pageOf = (query) => ({ limit: pageSize(query && query.limit), offset: pageOffset(query && query.offset) });

/**
 * De lijstvorm van een antwoord: de rijen, het totaal en of er meer zijn dan getoond.
 * @param {object[]} items De rijen van deze pagina.
 * @param {number} total Het totaal aantal rijen met dezelfde filters.
 * @param {{ limit: number, offset: number }} page De gevraagde pagina.
 * @returns {{ items: object[], total: number, truncated: boolean }} Het antwoord.
 */
const pagedBody = (items, total, page) => ({ items, total, truncated: page.offset + items.length < total });

module.exports = { LIST_LIMIT, pageSize, pageOffset, pageOf, pagedBody };
