// Vaste mappen van de app op één plek, zodat modules in een submap van src/
// niet zelf '..'-stappen hoeven te tellen.
const path = require('path');

/** Map met de frontend (beregeningsplanner/frontend): pagina's, modules en de gedeelde UMD-code. */
const FRONTEND_DIR = path.join(__dirname, '..', '..', 'frontend');
/** Map met de pagina's die de server zelf vult (inloggen, eerste beheerder, wachtwoord). */
const PAGES_DIR = path.join(__dirname, 'paginas');

module.exports = { FRONTEND_DIR, PAGES_DIR };
