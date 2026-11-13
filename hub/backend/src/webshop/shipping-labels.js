// Verzendlabels van een vervoerder (punt 16, orderpick-app): de haak waar de DPD-koppeling later in past. Zolang er geen koppeling is
// (de DPD-gegevens zijn nog niet ingesteld) meldt `forShipment` netjes `not_configured` en gaat de bestelling gewoon zonder label
// verder; de picker print dan geen label. Een koppeling is een object per vervoerder (de sleutel is de verzendmethode, nu alleen `dpd`):
//
//   { configured(tenantId) -> boolean,
//     create(tenantId, { order, shipment }) -> Promise<{ trackingCode?: string, pdf: Buffer }> }
//
// Het label zelf wordt niet bewaard: `create` mag het opnieuw ophalen bij de vervoerder. De koppeling komt via
// `createApp({ shippingLabelProviders: { dpd } })` (tests gebruiken een nagebootste koppeling).

/** Verzendmethodes waarvoor een label van een vervoerder bestaat. */
const LABEL_CARRIERS = ['dpd'];

/**
 * Maakt de labeldienst.
 * @param {{ providers?: Object<string, { configured: Function, create: Function }> }} [options] De koppelingen per verzendmethode.
 * @returns {{ statusFor: Function, create: Function }} De functies.
 */
function createShippingLabels({ providers = {} } = {}) {
  /**
   * Of en hoe er voor deze bestelling een label kan komen.
   * @param {string} tenantId Id van de omgeving.
   * @param {{ shipping?: { method?: string }|null }} order De bestelling.
   * @returns {{ required: boolean, available: boolean, carrier: string }} `required` = de verzendmethode heeft een label (DPD), `available` = er is een werkende koppeling.
   */
  function statusFor(tenantId, order) {
    const carrier = order && order.shipping && LABEL_CARRIERS.includes(order.shipping.method) ? order.shipping.method : '';
    const provider = carrier ? providers[carrier] : null;
    return { required: Boolean(carrier), available: Boolean(provider && provider.configured(tenantId)), carrier };
  }

  /**
   * Maakt het label van een zending bij de vervoerder.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} order De bestelling.
   * @param {object} shipment De zending.
   * @returns {Promise<{ pdf?: Buffer, trackingCode?: string, code?: string, error?: string, status?: number }>} Het label, of `code` `label_not_required` / `label_not_configured` / `label_failed` met een melding.
   */
  async function create(tenantId, order, shipment) {
    const status = statusFor(tenantId, order);
    if (!status.required) return { code: 'label_not_required', error: 'Voor deze verzendmethode is geen label nodig.', status: 409 };
    if (!status.available) return { code: 'label_not_configured', error: 'De DPD-koppeling is nog niet ingesteld: er kan geen label worden gemaakt.', status: 409 };
    try {
      const made = await providers[status.carrier].create(tenantId, { order, shipment });
      if (!made || !Buffer.isBuffer(made.pdf) || !made.pdf.length) return { code: 'label_failed', error: 'De vervoerder gaf geen label terug.', status: 502 };
      return { pdf: made.pdf, trackingCode: made.trackingCode || '' };
    } catch (error) {
      return { code: 'label_failed', error: 'Het label maken is niet gelukt. Probeer het zo opnieuw.', status: 502, cause: error };
    }
  }

  return { statusFor, create };
}

module.exports = { createShippingLabels, LABEL_CARRIERS };
