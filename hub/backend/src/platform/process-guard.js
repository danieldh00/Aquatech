// Vangnet voor fouten buiten een verzoek (timers, achtergrondtaken): een niet-afgevangen belofte of uitzondering komt
// in het centrale logboek en de foutteller van Bewaking, in plaats van stil het proces te stoppen (audit T-14).

/**
 * Installeert de vangnetten op het proces. Een niet-afgevangen belofte wordt gelogd en geteld; het proces blijft draaien
 * (lopende verzoeken vallen niet weg). Een niet-afgevangen uitzondering laat de toestand van het proces onzeker: die wordt
 * gelogd en geteld, het logboek wordt weggeschreven en het proces stopt gecontroleerd (de container herstart).
 * @param {object} options appLog (error, flush), errorCounter (add), server (close, optioneel), onExit (standaard process.exit), processObject (standaard process; voor tests) en log (standaard console.error).
 * @returns {{ handleRejection: Function, handleException: Function }} De afhandelaars (voor tests).
 */
function installProcessGuard({ appLog, errorCounter, server = null, onExit = (code) => process.exit(code), processObject = process, log = (...args) => console.error(...args) }) {
  /**
   * Legt een fout vast in de console, het applicatielogboek en de foutteller.
   * @param {string} message Korte omschrijving van de situatie.
   * @param {*} reason De fout.
   * @returns {void}
   */
  function record(message, reason) {
    const text = String((reason && reason.message) || reason).slice(0, 300);
    log(`[proces] ${message}:`, reason);
    try { errorCounter.add(); } catch { /* de teller mag het vangnet niet breken */ }
    try { appLog.error('proces', `${message}: ${text}`, { data: { stack: String((reason && reason.stack) || '').split('\n').slice(0, 6).join('\n') } }); } catch { /* idem */ }
  }

  /**
   * Een belofte zonder afhandeling: loggen en melden, doorgaan.
   * @param {*} reason De afwijzing.
   * @returns {void}
   */
  function handleRejection(reason) {
    record('Niet-afgevangen fout in een achtergrondtaak', reason);
  }

  let exiting = false;
  /**
   * Een uitzondering zonder afhandeling: loggen, melden, het logboek wegschrijven en gecontroleerd stoppen.
   * @param {*} error De fout.
   * @returns {void}
   */
  function handleException(error) {
    record('Niet-afgevangen uitzondering, het proces stopt', error);
    if (exiting) return;
    exiting = true;
    try { appLog.flush(); } catch { /* al gelogd in de console */ }
    /**
     * Stopt het proces.
     * @returns {void}
     */
    const finish = () => onExit(1);
    try {
      if (server && typeof server.close === 'function') server.close(finish);
      else finish();
    } catch { finish(); }
    const timer = setTimeout(finish, 3000);
    if (timer.unref) timer.unref();
  }

  processObject.on('unhandledRejection', handleRejection);
  processObject.on('uncaughtException', handleException);
  return { handleRejection, handleException };
}

module.exports = { installProcessGuard };
