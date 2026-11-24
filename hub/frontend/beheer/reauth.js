// Herbevestiging in Beheer: een venster dat het eigen wachtwoord (en, bij tweestapsverificatie, de code) vraagt voor
// gevaarlijke acties (back-up verwijderen, Google Drive verbreken of opnieuw koppelen). De server controleert ze opnieuw
// (backend/src/platform/identity-confirm.js); dit venster verzamelt ze alleen.
(function () {
  /**
   * Vraagt het wachtwoord en de eventuele tweestapscode in een venster.
   * @param {string} title De titel van het venster.
   * @param {string} text Uitleg wat er gaat gebeuren.
   * @returns {Promise<?{ password: string, totp: string }>} De ingevulde waarden, of null als de gebruiker annuleert.
   */
  function ask(title, text) {
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'reauth-dialog';
      dialog.innerHTML = `<form method="dialog" class="form-grid">
        <h3 class="full"></h3>
        <p class="full muted"></p>
        <label class="full">Wachtwoord<input type="password" name="password" autocomplete="current-password" required></label>
        <label class="full">Code authenticator-app (alleen bij tweestapsverificatie)<input type="text" name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="40"></label>
        <div class="form-actions full"><button type="submit" class="btn danger">Bevestigen</button><button type="button" class="btn" data-cancel>Annuleren</button></div>
      </form>`;
      dialog.querySelector('h3').textContent = title;
      dialog.querySelector('p').textContent = text;
      const form = dialog.querySelector('form');
      let result = null;
      form.addEventListener('submit', () => { result = { password: form.elements.password.value, totp: form.elements.totp.value.trim() }; });
      dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
      document.body.appendChild(dialog);
      dialog.showModal();
      form.elements.password.focus();
    });
  }
  window.BeheerReauth = { ask };
})();
