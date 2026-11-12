// Dropshipping: op de pagina van een bestelling de eigen pakbon (PDF) van de klant uploaden of vervangen. De PDF gaat als
// gewone bestandsinhoud (POST, type application/pdf) naar het adres `pakbon` van de bestelling; de server controleert hem opnieuw.
// Zonder script is uploaden niet mogelijk.

const MAX_SLIP_BYTES = 2 * 1024 * 1024;
const uploadBlock = document.querySelector('[data-slip-upload]');
if (uploadBlock) {
  const fileInput = uploadBlock.querySelector('[data-slip-file]');
  const sendButton = uploadBlock.querySelector('[data-slip-send]');
  const message = uploadBlock.querySelector('[data-slip-message]');

  /**
   * Toont een melding onder het formulier.
   * @param {string} text De melding (leeg verbergt hem).
   * @param {boolean} [isError] Of het een fout is.
   * @returns {void}
   */
  const show = (text, isError = false) => {
    message.textContent = text;
    message.hidden = !text;
    message.className = isError ? 'form-error' : 'note';
  };

  /**
   * Controleert het gekozen bestand en stuurt het naar de server; daarna wordt de pagina ververst met de nieuwe pakbon.
   * @returns {Promise<void>}
   */
  sendButton.addEventListener('click', async () => {
    const file = fileInput.files[0];
    if (!file) return show('Kies eerst een PDF-bestand.', true);
    if (file.size > MAX_SLIP_BYTES) return show('De pakbon is te groot (hoogstens 2 MB).', true);
    sendButton.disabled = true;
    show('Bezig met uploaden…');
    try {
      const response = await fetch('pakbon', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: file, credentials: 'same-origin', cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || `Uploaden is niet gelukt (status ${response.status}).`);
      window.location.reload();
    } catch (error) {
      show(error.message, true);
      sendButton.disabled = false;
    }
  });
}
