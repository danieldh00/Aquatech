// Actieve omgeving (live of test) voor alle pagina's. De server zet bij een
// testomgeving de leesbare cookie `aquatech_env_hint` (`<code>|<naam>`); die
// beveiligt niets, maar toont een testlabel in de kopbalk en scheidt het lokale
// concept van de planner per omgeving, zodat live en test niet door elkaar lopen.
(function (root) {
  /**
   * Leest de testomgeving uit de cookie aquatech_env_hint.
   * @returns {{ slug: string, name: string }|null} Code en naam, of null in live.
   */
  function read() {
    const match = /(?:^|;\s*)aquatech_env_hint=([^;]*)/.exec(document.cookie || '');
    if (!match) return null;
    let raw = '';
    try { raw = decodeURIComponent(match[1]); } catch (error) { return null; }
    const separator = raw.indexOf('|');
    if (separator < 1) return null;
    return { slug: raw.slice(0, separator), name: raw.slice(separator + 1) || 'Test' };
  }

  const env = read();

  /** Toont het testlabel in de kopbalk en zet [TEST] voor de titel. */
  function mark() {
    if (!env) return;
    document.documentElement.classList.add('env-test');
    if (!/^\[TEST\]/.test(document.title)) document.title = `[TEST] ${document.title}`;
    const bar = document.querySelector('.topbar');
    if (!bar || bar.querySelector('.env-badge')) return;
    const badge = document.createElement('span');
    badge.className = 'env-badge';
    badge.title = 'Je werkt in een testomgeving: plannen, historie en instellingen staan los van live.';
    badge.textContent = /^test$/i.test(env.name) ? 'Test' : `Test · ${env.name}`;
    const brand = bar.querySelector('.brand');
    if (brand && brand.nextSibling) bar.insertBefore(badge, brand.nextSibling);
    else bar.appendChild(badge);
  }

  // Impersonatie: een hoofdbeheerder werkt als een andere gebruiker, of een
  // beheerder bekijkt in een testomgeving de app als klant. De server zet dan de
  // leesbare cookie `aquatech_imp_hint` (`<naam>|<verloopt>|live|test|klant`).
  // Op elke pagina staat zolang een balk met de knop terug.
  const script = document.currentScript;
  /**
   * Adres relatief aan de map van de app (dit script staat in shared/).
   * @param {string} relative Pad vanaf shared/.
   * @returns {string} Het volledige adres.
   */
  const fromApp = (relative) => (script && script.src ? new URL(relative, script.src).href : relative);

  /**
   * Leest de impersonatie uit de cookie aquatech_imp_hint.
   * @returns {{ name: string, expiresAt: string, live: boolean, customerView: boolean }|null} Naam, einde, omgeving en of het een klantweergave is, of null.
   */
  function readImpersonation() {
    const match = /(?:^|;\s*)aquatech_imp_hint=([^;]*)/.exec(document.cookie || '');
    if (!match) return null;
    let raw = '';
    try { raw = decodeURIComponent(match[1]); } catch (error) { return null; }
    const parts = raw.split('|');
    if (parts.length < 3) return null;
    const kind = parts.pop();
    const expiresAt = parts.pop();
    return { name: parts.join('|'), expiresAt, live: kind === 'live', customerView: kind === 'klant' };
  }

  const impersonation = readImpersonation();

  /**
   * Stopt de impersonatie en gaat terug naar Hoofdbeheer (of na een klantweergave naar Beheer > Gebruikers).
   * @param {HTMLButtonElement} [button] De knop (wordt uitgezet).
   * @returns {Promise<void>}
   */
  async function stopImpersonation(button) {
    if (button) button.disabled = true;
    try {
      await fetch(fromApp('../api/impersonation/stop'), { method: 'POST' });
    } catch (error) { /* toch terug: de server ruimt een verlopen impersonatie zelf op */ }
    location.href = fromApp(impersonation && impersonation.customerView ? '../beheer/#users' : '../hoofdbeheer/');
  }

  /**
   * Tijdstip waarop de impersonatie afloopt, kort geschreven.
   * @returns {string} Bijv. "do 14:30", of leeg.
   */
  function untilText() {
    const until = new Date(impersonation.expiresAt);
    return isNaN(until) ? '' : until.toLocaleString('nl-NL', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }

  /** Toont bovenin de balk "Je bekijkt als …" met de knop terug naar Beheer (klantweergave). */
  function markCustomerView() {
    document.documentElement.classList.add('customer-view');
    const bar = document.createElement('div');
    bar.className = 'imp-bar customer-view-bar';
    bar.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.className = 'imp-text';
    const who = document.createElement('b');
    who.textContent = impersonation.name;
    const time = untilText();
    text.append('Je bekijkt als ', who, ` · testomgeving${time ? ` · tot ${time}` : ''}`);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Terug naar beheer';
    /**
     * Stopt de klantweergave.
     * @returns {Promise<void>}
     */
    button.onclick = () => stopImpersonation(button);
    bar.append(text, button);
    document.body.insertBefore(bar, document.body.firstChild);
  }

  /** Toont de balk "Je werkt als …" met de knop terug naar het eigen account. */
  function markImpersonation() {
    if (!impersonation || document.querySelector('.imp-bar')) return;
    document.documentElement.classList.add('impersonating');
    if (impersonation.customerView) { markCustomerView(); return; }
    const time = untilText();
    const bar = document.createElement('div');
    bar.className = 'imp-bar';
    bar.setAttribute('role', 'status');
    const text = document.createElement('span');
    text.className = 'imp-text';
    const who = document.createElement('b');
    who.textContent = impersonation.name;
    text.append('Je werkt als ', who, ` · ${impersonation.live ? 'live, met toestemming' : 'testomgeving'}${time ? ` · tot ${time}` : ''}`);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Terug naar eigen account';
    /**
     * Stopt de impersonatie.
     * @returns {Promise<void>}
     */
    button.onclick = () => stopImpersonation(button);
    bar.append(text, button);
    document.body.appendChild(bar);
  }

  root.AquatechEnv = {
    current: env,
    isTest: Boolean(env),
    /**
     * Achtervoegsel voor localStorage-sleutels. Tijdens een impersonatie apart,
     * zodat het lokale concept van de hoofdbeheerder en dat van de gebruiker
     * niet door elkaar lopen.
     * @returns {string} Leeg in live; @code in een testomgeving, plus #als:naam tijdens een impersonatie.
     */
    storageSuffix: () => (env ? `@${env.slug}` : '') + (impersonation ? `#als:${impersonation.name}` : ''),
    impersonation,
    stopImpersonation,
  };

  /** Kleur van de browserbalk (mobiel) volgt het kleurthema (shared/theme.css). */
  function themeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    const navy = getComputedStyle(document.documentElement).getPropertyValue('--at-navy').trim();
    if (meta && /^#[0-9a-f]{6}$/i.test(navy)) meta.setAttribute('content', navy);
  }

  /** Alles klaarzetten zodra de pagina geladen is. */
  const ready = () => { mark(); markImpersonation(); themeColor(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})(window);
