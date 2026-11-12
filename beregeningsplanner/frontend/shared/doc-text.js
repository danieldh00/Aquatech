// Teksten van de documenten voor klanten (offerte, factuur-PDF en de bijbehorende e-mails) in het Nederlands en het
// Engels. Gedeeld door de browser (offerte, openbare offertepagina) en de server (factuur-PDF, e-mail). De taal staat
// per klant (`users.document_language`) en wordt op de offerte en de factuur vastgelegd (`data.language`).
// Gewoon script, UMD; geen afhankelijkheden.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DocText = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  /** De talen waarin een document kan worden opgemaakt, met de naam in die taal. */
  const LANGUAGES = { nl: 'Nederlands', en: 'English' };
  /** Landinstelling per taal voor datums, bedragen en getallen. */
  const LOCALES = { nl: 'nl-NL', en: 'en-GB' };

  /** De teksten per taal; {naam} wordt door `text` ingevuld. */
  const TEXTS = {
    nl: {
      'section.materiaal': 'Materialen', 'section.arbeid': 'Arbeid', 'section.overig': 'Overig',
      'quote.title': 'Offerte', 'quote.for': 'Offerte voor', 'quote.attn': 'T.a.v.', 'quote.number': 'Offertenummer', 'quote.date': 'Datum',
      'quote.validUntil': 'Geldig tot', 'quote.paymentTerm': 'Betaaltermijn', 'quote.days': 'dagen', 'quote.reference': 'Uw referentie',
      'quote.design': 'Ontwerp', 'quote.lawn': 'm² gazon', 'quote.sprinklers': 'sproeiers', 'quote.zones': 'zones', 'quote.level': 'uitvoering',
      'col.description': 'Omschrijving', 'col.qty': 'Aantal', 'col.unit': 'Eenh.', 'col.price': 'Prijs', 'col.vat': 'Btw', 'col.total': 'Totaal', 'col.amount': 'Bedrag',
      'quote.noLines': 'Geen regels.', 'quote.sectionTotal': 'Totaal {section}', 'quote.shifted': 'verlegd',
      'quote.optionsInteractive': 'Regels met <b>Optie</b> kiest u zelf: vink ze aan om ze mee te nemen; het totaal past zich aan.',
      'quote.optionsStatic': 'Regels met <b>Optie</b> tellen alleen mee als ze gekozen zijn.',
      'quote.subtotal': 'Subtotaal', 'quote.discount': 'Korting', 'quote.netTotal': 'Totaal excl. btw', 'quote.vat': 'Btw',
      'quote.totalShifted': 'Totaal (btw verlegd)', 'quote.totalIncl': 'Totaal incl. btw',
      'quote.shiftNote': 'Btw verlegd naar de afnemer{number}: intracommunautaire levering.', 'quote.vatNumber': 'btw-nummer',
      'quote.terms': 'Voorwaarden', 'quote.forApproval': 'Voor akkoord', 'quote.nameDate': 'Naam en datum', 'quote.signature': 'Handtekening',
      'quote.accepted': 'Digitaal geaccordeerd', 'quote.acceptedBy': 'Door {name} op {when}, voor {amount} {vat}, met akkoord op de voorwaarden.',
      'quote.vatShifted': '(btw verlegd)', 'quote.inclVat': 'incl. btw', 'quote.signatureOf': 'Handtekening van {name}',
      'quote.viaAccount': 'Via het klantaccount', 'quote.viaLink': 'Via de offertelink', 'quote.reported': 'opgegeven', 'quote.ref': 'kenmerk',
      'quote.rejected': 'Afgewezen', 'quote.rejectedBy': 'Door {name} op {when}.', 'quote.theCustomer': 'de klant', 'quote.reason': 'Reden',
      'quote.noRecipient': '–', 'quote.deliveryTo': 'Afleveradres',
      'sign.heading': 'Akkoord geven', 'sign.totalPre': 'Totaal:', 'sign.totalPost': 'incl. btw', 'sign.nameLabel': 'Uw naam', 'sign.namePlaceholder': 'Voor- en achternaam',
      'sign.signatureLabel': 'Uw handtekening', 'sign.padLabel': 'Tekenvak voor uw handtekening', 'sign.padHint': 'Teken hier met muis of vinger', 'sign.clear': 'Wissen',
      'sign.terms': 'Ik ga akkoord met deze offerte en de voorwaarden', 'sign.read': 'lezen', 'sign.accept': 'Akkoord geven', 'sign.rejectOpen': 'Afwijzen',
      'sign.whyLabel': 'Wilt u laten weten waarom? (niet verplicht)', 'sign.reject': 'Offerte afwijzen',
      'sign.enterName': 'Vul uw naam in.', 'sign.needSignature': 'Zet uw handtekening in het tekenvak.', 'sign.needTerms': 'Vink aan dat u akkoord gaat met de offerte en de voorwaarden.',
      'sign.confirmReject': 'Weet u zeker dat u deze offerte wilt afwijzen?',
      'public.accepted': 'U heeft deze offerte geaccordeerd op {when}. Bedankt! U kunt hem hieronder als PDF opslaan.',
      'public.rejected': 'Deze offerte is afgewezen op {when}. Neem gerust contact op als u een aangepaste offerte wilt.',
      'public.answered': 'Deze offerte is al beantwoord.', 'public.expired': 'Deze offerte was geldig tot {date}. Neem contact op voor een nieuwe offerte.',
      'public.open': 'Bekijk de offerte en geef onderaan uw akkoord. Geldig tot {date}.', 'public.preview': ' (Voorbeeld: het openen telt niet als bekeken.)',
      'packing.title': 'Pakbon', 'packing.continued': 'vervolg', 'packing.deliverTo': 'Afleveradres', 'packing.customer': 'Klant', 'packing.pickup': 'Wordt opgehaald',
      'packing.order': 'Bestelling', 'packing.orderedOn': 'Besteld op', 'packing.shipping': 'Verzending', 'packing.phone': 'Telefoon', 'packing.location': 'Locatie',
      'packing.article': 'Artikel', 'packing.qty': 'Aantal', 'packing.unit': 'Eenh.', 'packing.baseQty': '= {qty} stuks', 'packing.note': 'Opmerking van de klant', 'packing.page': 'Pagina {page} van {count}',
      'invoice.title': 'Factuur', 'invoice.credit': 'Creditfactuur', 'invoice.draft': 'concept', 'invoice.continued': 'vervolg', 'invoice.to': 'Aan',
      'invoice.attn': 't.a.v.', 'invoice.numberLabel': 'Factuurnummer', 'invoice.creditNumber': 'Creditnummer', 'invoice.dateLabel': 'Factuurdatum',
      'invoice.creditOf': 'Credit van', 'invoice.dueDate': 'Vervaldatum', 'invoice.debtor': 'Debiteurnummer', 'invoice.workOrder': 'Werkorder',
      'invoice.about': 'Betreft', 'invoice.customerVat': 'Btw-nummer klant', 'invoice.subtotal': 'Subtotaal', 'invoice.discount': 'Korting',
      'invoice.vatOver': 'Btw {rate}% over {base}', 'invoice.total': 'Totaal', 'invoice.paid': 'Deze factuur is voldaan{when}. Dank u wel.', 'invoice.paidOn': ' op {date}',
      'invoice.page': 'Pagina {page} van {count}', 'invoice.concept': 'CONCEPT', 'invoice.unit': 'Eenh.',
      'mail.quoteSubject': 'Uw offerte {number}', 'mail.invoiceSubject': '{soort} {nummer} van {bedrijf}',
      'mail.invoiceBody': 'Beste {klant},\n\nIn de bijlage vindt u {soort_klein} {nummer} van {datum} voor {bedrag} incl. btw.\n\n{betaling}\n\nMet vriendelijke groet,\n{bedrijf}',
      'mail.creditSettled': 'Het bedrag verrekenen wij met u.', 'mail.alreadyPaid': 'Deze factuur is al voldaan, dank u wel.', 'mail.customer': 'klant',
      'mail.quoteBody': 'Hierbij ontvangt u onze offerte {number}{about}. Via de knop hieronder bekijkt u de offerte online en kunt u direct digitaal akkoord geven. De offerte is geldig tot {date}.',
      'mail.confirmSubject': 'Bevestiging: offerte {number} geaccordeerd', 'mail.confirmThanks': 'Bedankt voor uw akkoord op offerte {number}{about} op {when}, voor {amount} incl. btw.',
      'mail.confirmLink': 'Via de knop hieronder bekijkt u de geaccordeerde offerte met uw handtekening; daar kunt u hem ook als PDF opslaan.',
      'mail.confirmNext': 'Wij nemen contact met u op om de werkzaamheden in te plannen.', 'mail.confirmButton': 'Geaccordeerde offerte bekijken',
      'mail.quoteQuestions': 'Heeft u vragen, neem dan gerust contact met ons op.', 'mail.quoteAboutLower': ' voor {title}',
      'mail.quoteAbout': ' voor {title}', 'mail.greeting': 'Beste {name},', 'mail.closing': 'Met vriendelijke groet,', 'mail.viewQuote': 'Offerte bekijken', 'mail.sendButton': 'Offerte bekijken en accorderen',
    },
    en: {
      'section.materiaal': 'Materials', 'section.arbeid': 'Labour', 'section.overig': 'Other',
      'quote.title': 'Quotation', 'quote.for': 'Quotation for', 'quote.attn': 'Attn.', 'quote.number': 'Quotation number', 'quote.date': 'Date',
      'quote.validUntil': 'Valid until', 'quote.paymentTerm': 'Payment term', 'quote.days': 'days', 'quote.reference': 'Your reference',
      'quote.design': 'Design', 'quote.lawn': 'm² lawn', 'quote.sprinklers': 'sprinklers', 'quote.zones': 'zones', 'quote.level': 'specification',
      'col.description': 'Description', 'col.qty': 'Qty', 'col.unit': 'Unit', 'col.price': 'Price', 'col.vat': 'VAT', 'col.total': 'Total', 'col.amount': 'Amount',
      'quote.noLines': 'No lines.', 'quote.sectionTotal': 'Total {section}', 'quote.shifted': 'reverse charge',
      'quote.optionsInteractive': 'Lines marked <b>Option</b> are your choice: tick them to include them; the total adjusts.',
      'quote.optionsStatic': 'Lines marked <b>Option</b> only count when they are selected.',
      'quote.subtotal': 'Subtotal', 'quote.discount': 'Discount', 'quote.netTotal': 'Total excl. VAT', 'quote.vat': 'VAT',
      'quote.totalShifted': 'Total (VAT reverse charged)', 'quote.totalIncl': 'Total incl. VAT',
      'quote.shiftNote': 'VAT reverse charged to the customer{number}: intra-community supply.', 'quote.vatNumber': 'VAT number',
      'quote.terms': 'Terms and conditions', 'quote.forApproval': 'For approval', 'quote.nameDate': 'Name and date', 'quote.signature': 'Signature',
      'quote.accepted': 'Accepted digitally', 'quote.acceptedBy': 'By {name} on {when}, for {amount} {vat}, agreeing to the terms and conditions.',
      'quote.vatShifted': '(VAT reverse charged)', 'quote.inclVat': 'incl. VAT', 'quote.signatureOf': 'Signature of {name}',
      'quote.viaAccount': 'Via the customer account', 'quote.viaLink': 'Via the quotation link', 'quote.reported': 'reported', 'quote.ref': 'reference',
      'quote.rejected': 'Declined', 'quote.rejectedBy': 'By {name} on {when}.', 'quote.theCustomer': 'the customer', 'quote.reason': 'Reason',
      'quote.noRecipient': '–', 'quote.deliveryTo': 'Delivery address',
      'sign.heading': 'Approve quotation', 'sign.totalPre': 'Total:', 'sign.totalPost': 'incl. VAT', 'sign.nameLabel': 'Your name', 'sign.namePlaceholder': 'First and last name',
      'sign.signatureLabel': 'Your signature', 'sign.padLabel': 'Box for your signature', 'sign.padHint': 'Draw here with mouse or finger', 'sign.clear': 'Clear',
      'sign.terms': 'I agree to this quotation and the terms and conditions', 'sign.read': 'read', 'sign.accept': 'Approve', 'sign.rejectOpen': 'Decline',
      'sign.whyLabel': 'Would you like to tell us why? (optional)', 'sign.reject': 'Decline quotation',
      'sign.enterName': 'Enter your name.', 'sign.needSignature': 'Draw your signature in the box.', 'sign.needTerms': 'Tick that you agree to the quotation and the terms and conditions.',
      'sign.confirmReject': 'Are you sure you want to decline this quotation?',
      'public.accepted': 'You approved this quotation on {when}. Thank you! You can save it as a PDF below.',
      'public.rejected': 'This quotation was declined on {when}. Feel free to contact us if you would like an adjusted quotation.',
      'public.answered': 'This quotation has already been answered.', 'public.expired': 'This quotation was valid until {date}. Please contact us for a new quotation.',
      'public.open': 'Review the quotation and approve it at the bottom. Valid until {date}.', 'public.preview': ' (Preview: opening it does not count as viewed.)',
      'packing.title': 'Packing slip', 'packing.continued': 'continued', 'packing.deliverTo': 'Delivery address', 'packing.customer': 'Customer', 'packing.pickup': 'Collected by the customer',
      'packing.order': 'Order', 'packing.orderedOn': 'Ordered on', 'packing.shipping': 'Shipping', 'packing.phone': 'Phone', 'packing.location': 'Location',
      'packing.article': 'Item', 'packing.qty': 'Qty', 'packing.unit': 'Unit', 'packing.baseQty': '= {qty} pieces', 'packing.note': 'Customer note', 'packing.page': 'Page {page} of {count}',
      'invoice.title': 'Invoice', 'invoice.credit': 'Credit note', 'invoice.draft': 'draft', 'invoice.continued': 'continued', 'invoice.to': 'To',
      'invoice.attn': 'attn.', 'invoice.numberLabel': 'Invoice number', 'invoice.creditNumber': 'Credit note number', 'invoice.dateLabel': 'Invoice date',
      'invoice.creditOf': 'Credit for', 'invoice.dueDate': 'Due date', 'invoice.debtor': 'Customer number', 'invoice.workOrder': 'Work order',
      'invoice.about': 'Subject', 'invoice.customerVat': 'Customer VAT number', 'invoice.subtotal': 'Subtotal', 'invoice.discount': 'Discount',
      'invoice.vatOver': 'VAT {rate}% on {base}', 'invoice.total': 'Total', 'invoice.paid': 'This invoice has been paid{when}. Thank you.', 'invoice.paidOn': ' on {date}',
      'invoice.page': 'Page {page} of {count}', 'invoice.concept': 'DRAFT', 'invoice.unit': 'Unit',
      'mail.quoteSubject': 'Your quotation {number}', 'mail.invoiceSubject': '{soort} {nummer} from {bedrijf}',
      'mail.invoiceBody': 'Dear {klant},\n\nPlease find attached {soort_klein} {nummer} dated {datum} for {bedrag} incl. VAT.\n\n{betaling}\n\nKind regards,\n{bedrijf}',
      'mail.creditSettled': 'We will settle the amount with you.', 'mail.alreadyPaid': 'This invoice has already been paid, thank you.', 'mail.customer': 'customer',
      'mail.quoteBody': 'Please find our quotation {number}{about}. Use the button below to view the quotation online and approve it digitally right away. The quotation is valid until {date}.',
      'mail.confirmSubject': 'Confirmation: quotation {number} approved', 'mail.confirmThanks': 'Thank you for approving quotation {number}{about} on {when}, for {amount} incl. VAT.',
      'mail.confirmLink': 'Use the button below to view the approved quotation with your signature; you can also save it as a PDF there.',
      'mail.confirmNext': 'We will contact you to schedule the work.', 'mail.confirmButton': 'View approved quotation',
      'mail.quoteQuestions': 'If you have any questions, please do not hesitate to contact us.', 'mail.quoteAboutLower': ' for {title}',
      'mail.quoteAbout': ' for {title}', 'mail.greeting': 'Dear {name},', 'mail.closing': 'Kind regards,', 'mail.viewQuote': 'View quotation', 'mail.sendButton': 'View and approve quotation',
    },
  };

  /**
   * Maakt van willekeurige invoer een ondersteunde taal.
   * @param {*} language De ingevulde taal.
   * @returns {string} 'nl' of 'en' (onbekend of leeg = 'nl').
   */
  const clean = (language) => (Object.prototype.hasOwnProperty.call(LANGUAGES, String(language || '').toLowerCase()) ? String(language).toLowerCase() : 'nl');

  /**
   * De landinstelling voor datums en bedragen in een taal.
   * @param {string} language De taal.
   * @returns {string} Bijvoorbeeld 'nl-NL'.
   */
  const localeOf = (language) => LOCALES[clean(language)];

  /**
   * Een tekst in de gevraagde taal, met {naam} ingevuld. Een ontbrekende sleutel valt terug op het Nederlands en daarna op de sleutel zelf.
   * @param {string} language De taal.
   * @param {string} key De sleutel, bijvoorbeeld 'quote.title'.
   * @param {object} [values] Waarden voor {naam}.
   * @returns {string} De tekst.
   */
  function text(language, key, values = {}) {
    const table = TEXTS[clean(language)];
    const template = table[key] !== undefined ? table[key] : (TEXTS.nl[key] !== undefined ? TEXTS.nl[key] : key);
    return template.replace(/\{(\w+)\}/g, (match, name) => (values[name] !== undefined && values[name] !== null ? String(values[name]) : match));
  }

  return { LANGUAGES, clean, localeOf, text, TEXTS };
}));
