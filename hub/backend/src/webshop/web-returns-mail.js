// Mails bij een retour van een webshopbestelling: een bevestiging aan de klant en
// een melding aan het bedrijf (e-mailadres uit het bedrijfsprofiel) bij een
// aanvraag, het besluit (goedgekeurd met retouradres, of afgewezen met reden) en
// het bericht dat de retour is afgerond. Via de mailserver van de organisatie
// (mailer.js); een mislukte verzending houdt de retour niet tegen maar blijft
// zichtbaar bij de retour (data.mail).
const { validEmail, mailFailure, MAIL_SETUP_FAILED } = require('../platform/mailer');
const { mailStyleOf, composeFor } = require('../platform/mail-layout');

/**
 * Maakt de verzender van retourmails.
 * @param {{ returns: object, settingsFor: Function, mailerFor: Function, mailBody: Function }} deps De retouropslag, de instellingen per omgeving, de mailserver en de opmaak van de mail.
 * @returns {{ sendRequested: Function, sendDecision: Function, sendCompleted: Function }} De functies.
 */
function createReturnMailer({ returns, settingsFor, mailerFor, mailBody }) {
  /**
   * De teruggestuurde regels als tekst, één per regel.
   * @param {object} record De retour.
   * @returns {string} De regels.
   */
  const linesText = (record) => record.lines.map((line) => `${line.qty} × ${line.name} (${line.code})`).join('\n');
  /**
   * Het kader van elke mail: de retour met bestelnummer, regels en reden.
   * @param {object} record De retour.
   * @returns {string} De tekst.
   */
  const detailsText = (record) => `Retour ${record.number} bij bestelling ${record.orderNumber}\n\n${linesText(record)}\n\nReden: ${record.reasonLabel}${record.note ? `\nToelichting: ${record.note}` : ''}`;

  /**
   * Verstuurt een mail en legt vast hoe dat is gegaan.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} record De retour.
   * @param {string} kind Welke mail het is (aanvraag, besluit, afgerond), voor in het logboek.
   * @param {(profile: object, settings: object) => { subject: string, paragraphs: string[], shop?: { subject: string, paragraphs: string[] } }} compose Maakt de inhoud van de mail met het bedrijfsprofiel.
   * @returns {Promise<void>}
   */
  async function deliver(tenantId, record, kind, compose) {
    /**
     * Legt de uitkomst van de mail vast bij de retour.
     * @param {{ sent: boolean, error: string }} patch Of de mail is verstuurd en anders de fout.
     * @returns {void}
     */
    const log = (patch) => returns.updateData(tenantId, record.id, { mail: { kind, at: new Date().toISOString(), ...patch } });
    let mailer;
    let profile;
    let settings;
    try {
      settings = settingsFor(tenantId);
      mailer = mailerFor(settings);
      profile = settings.get('quoteProfile') || {};
    } catch (failure) {
      console.error('Mailinstellingen lezen mislukt:', failure);
      log({ sent: false, error: MAIL_SETUP_FAILED });
      return;
    }
    if (!mailer.configured()) { log({ sent: false, error: 'Geen mailserver ingesteld.' }); return; }
    let error = '';
    try {
      const content = compose(profile, settings);
      const style = mailStyleOf(settings);
      const message = mailBody(profile, content.paragraphs, undefined, style);
      await mailer.send({ to: record.email, subject: content.subject, text: message.text, html: message.html, replyTo: validEmail(profile.email) ? profile.email : undefined });
      if (content.shop && validEmail(profile.email)) {
        const shopMessage = mailBody(profile, content.shop.paragraphs, undefined, style);
        await mailer.send({ to: profile.email, subject: content.shop.subject, text: shopMessage.text, html: shopMessage.html });
      }
    } catch (failure) {
      error = mailFailure(failure).slice(0, 300);
    }
    log({ sent: !error, error });
  }

  /**
   * Bevestigt de aanvraag aan de klant en meldt hem aan het bedrijf.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} record De aangevraagde retour.
   * @returns {Promise<void>}
   */
  const sendRequested = (tenantId, record) => deliver(tenantId, record, 'aangevraagd', (_profile, settings) => ({
    ...composeFor(settings, 'retour_ontvangen', { klant: record.customerName, nummer: record.number, specificatie: detailsText(record) }),
    shop: { subject: `Nieuwe retouraanvraag ${record.number}`, paragraphs: [`Nieuwe retouraanvraag van ${record.customerName} (${record.email}).`, detailsText(record)] },
  }));

  /**
   * Meldt de klant het besluit: goedgekeurd (met het adres om naartoe te sturen) of afgewezen (met de reden).
   * @param {string} tenantId Id van de omgeving.
   * @param {object} record De retour met status goedgekeurd of afgewezen.
   * @returns {Promise<void>}
   */
  const sendDecision = (tenantId, record) => deliver(tenantId, record, record.status, (profile, settings) => {
    const approved = record.status === 'goedgekeurd';
    const instruction = `${profile.address ? `Stuur de artikelen terug naar:\n${profile.address}\n\nVermeld retournummer ${record.number} in het pakket.` : `Het retouradres ontvang je van ons; antwoord op deze mail als je het nog niet hebt. Vermeld retournummer ${record.number} in het pakket.`}${record.decisionNote ? `\n\n${record.decisionNote}` : ''}`;
    return composeFor(settings, approved ? 'retour_goedgekeurd' : 'retour_afgewezen', {
      klant: record.customerName, nummer: record.number, specificatie: detailsText(record), instructie: instruction, reden: record.decisionNote || '',
    });
  });

  /**
   * Meldt de klant dat de retour is ontvangen en afgehandeld, met het nummer van de creditnota als die er is.
   * @param {string} tenantId Id van de omgeving.
   * @param {object} record De afgeronde retour.
   * @returns {Promise<void>}
   */
  const sendCompleted = (tenantId, record) => deliver(tenantId, record, 'afgerond', (_profile, settings) => composeFor(settings, 'retour_afgehandeld', {
    klant: record.customerName, nummer: record.number, specificatie: detailsText(record),
    afhandeling: `We hebben de artikelen van je retour ontvangen.${record.credit ? ` Je creditnota ${record.credit.number} is aangemaakt${record.credit.status === 'concept' ? ' en volgt zo snel mogelijk' : ' en komt apart in je mailbox'}.` : ' Je ontvangt de creditnota van ons.'}`,
  }));

  return { sendRequested, sendDecision, sendCompleted };
}

module.exports = { createReturnMailer };
