// Bewaart per hoofdartikel wat de AI-omschrijving nodig heeft in de kolom item_specs.specs (geen eigen tabel, dus geen migratie):
// - kenmerken: de opgezochte kenmerken met bronadres en bronzin (materiaal, afmetingen, werpstraal), plus kenmerkenAt (wanneer opgezocht, ook als er niets is gevonden);
// - textLog: wat de bulkrun met de omschrijving deed (nieuw, overschreven, behouden, hersteld), met bij overschreven de vorige tekst zodat die terug kan.
// Een artikel waarvan alleen dit is opgezocht krijgt een rij met status niet_gevonden en het kenmerk descOnly: Past bij (related-items.js) blijft
// die artikelen dan nog opzoeken en bewaart kenmerken en textLog bij het opslaan van nieuwe specificaties.

/**
 * Het huidige moment.
 * @returns {string} Tijdstip als ISO-tekst.
 */
const currentTimestamp = () => new Date().toISOString();

/**
 * Leest de specificaties uit de kolom.
 * @param {*} json De kolom item_specs.specs.
 * @returns {object} Het object (leeg bij onleesbare invoer).
 */
function parseSpecs(json) {
  try { const value = JSON.parse(json || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

/**
 * Maakt de opslag voor kenmerken en het schrijflogboek van omschrijvingen.
 * @param {object} db De database.
 * @returns {{ read: Function, saveFeatures: Function, recordWrite: Function }} De functies.
 */
function createItemTextLog(db) {
  /**
   * Maakt een query klaar.
   * @param {string} sql De query.
   * @returns {object} De voorbereide query.
   */
  const prepare = (sql) => db.prepare(sql);

  /**
   * De opgeslagen specificaties van een artikel.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @returns {object|null} De specificaties met onder meer kenmerken en textLog, of null zonder rij.
   */
  function read(tenantId, itemId) {
    const row = prepare('SELECT specs FROM item_specs WHERE tenant_id = ? AND item_id = ?').get(tenantId, String(itemId || ''));
    return row ? parseSpecs(row.specs) : null;
  }

  /**
   * Past de specificaties van een artikel aan; een ontbrekende rij wordt aangemaakt (alleen voor kenmerken en logboek).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {Function} change Krijgt het specificatieobject en wijzigt het.
   * @param {string} [model] Het model dat het gedaan heeft (voor de kolom model van een nieuwe rij).
   * @returns {void}
   */
  function update(tenantId, itemId, change, model = '') {
    const row = prepare('SELECT status, specs FROM item_specs WHERE tenant_id = ? AND item_id = ?').get(tenantId, itemId);
    const specs = row ? parseSpecs(row.specs) : { descOnly: true };
    change(specs);
    const json = JSON.stringify(specs);
    if (row) {
      prepare('UPDATE item_specs SET specs = ? WHERE tenant_id = ? AND item_id = ?').run(json, tenantId, itemId);
    } else {
      prepare("INSERT INTO item_specs (tenant_id, item_id, status, specs, model, checked_at) VALUES (?, ?, 'niet_gevonden', ?, ?, ?) ON CONFLICT (tenant_id, item_id) DO NOTHING")
        .run(tenantId, itemId, json, String(model || '').slice(0, 80), currentTimestamp());
    }
  }

  /**
   * Bewaart de opgezochte kenmerken van een artikel (vervangt eerdere).
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {{ features: object[], model?: string }} result De gevalideerde kenmerken (kan leeg zijn: dan is wel gezocht).
   * @returns {void}
   */
  function saveFeatures(tenantId, itemId, { features, model }) {
    update(tenantId, itemId, (specs) => { specs.kenmerken = features; specs.kenmerkenAt = currentTimestamp(); }, model);
  }

  /**
   * Legt vast wat er met de omschrijving van een artikel gebeurd is.
   * @param {string} tenantId Id van de omgeving.
   * @param {string} itemId Id van het artikel.
   * @param {{ action: string, model?: string, reason?: string, previous?: { text: string, source: string } }} entry nieuw, overschreven, behouden of hersteld; bij overschreven de vorige tekst en waar die stond (eigen of webshop).
   * @returns {void}
   */
  function recordWrite(tenantId, itemId, entry) {
    update(tenantId, itemId, (specs) => {
      specs.textLog = { action: entry.action, at: currentTimestamp(), model: String(entry.model || '').slice(0, 80), reason: String(entry.reason || '').slice(0, 300) };
      if (entry.previous) specs.textLog.previous = { text: String(entry.previous.text || '').slice(0, 20000), source: entry.previous.source === 'webshop' ? 'webshop' : 'eigen' };
    }, entry.model);
  }

  return { read, saveFeatures, recordWrite };
}

module.exports = { createItemTextLog, parseSpecs };
