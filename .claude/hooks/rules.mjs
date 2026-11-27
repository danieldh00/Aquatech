// Regels van de vangrail (guard.mjs): alle "niet doen"-regels uit CLAUDE.md en AGENTS.md die mechanisch te controleren zijn.
// Een regel kijkt alleen naar NIEUWE regels in een wijziging, dus bestaande code blokkeert niets.
// Samenstellen met losse stukjes, zodat dit bestand zelf niet op zijn eigen patronen aanslaat.

const MODEL = ['fa' + 'ble', 'op' + 'us', 'son' + 'net', 'hai' + 'ku'].join('|');

/** Regels voor bestandswijzigingen: { id, melding, paden, patroon, nietIn?, niveau? } (niveau: deny | warn). */
export const FILE_RULES = [
  {
    id: 'sqlite',
    melding: 'Geen SQLite (CLAUDE.md: PostgreSQL is de enige database, ook niet in tests).',
    paden: /^(hub|deploy|tests|docker-compose)/,
    patroon: /better-sqlite3|node:sqlite|\bsqlite3\b|\.sqlite\b|sqlite_master/i,
    nietIn: /\.md$/,
  },
  {
    id: 'vue',
    melding: 'Geen Vue (besluit Daniël 2026-11-25): gewone script-tags in de frontend.',
    paden: /^hub\/(frontend|backend\/package\.json)|\.vue$/,
    patroon: /["'`]vue["'`]|vue@|\bfrom ['"]vue|createApp\(\{[^}]*template/,
    nietIn: /\.md$/,
  },
  {
    id: 'select-star',
    melding: 'Geen SELECT * of t.* in de backend (kolommen expliciet noemen).',
    paden: /^hub\/backend\/src\/.*\.js$/,
    patroon: /\bSELECT\s+(?:DISTINCT\s+)?\*|\bSELECT\s+(?:DISTINCT\s+)?\w+\.\*|,\s*\w+\.\*\s+FROM\b/i,
  },
  {
    id: 'cdn',
    melding: 'Geen CDN in de frontend: vendor-bestanden lokaal in frontend/<module>/vendor/.',
    paden: /^hub\/frontend\/.*\.(html|css|js)$/,
    nietIn: /\/vendor\//,
    patroon: /<(?:script|link)\b[^>]*(?:src|href)=["']https?:\/\/|@import\s+url\(["']?https?:/i,
  },
  {
    id: 'absolute-url',
    melding: 'Alle URL\'s in de frontend relatief (css/app.css, nooit /css/...).',
    paden: /^hub\/frontend\/.*\.html$/,
    nietIn: /\/vendor\//,
    patroon: /<(?:script|link|img)\b[^>]*(?:src|href)=["']\/(?!\/)/i,
  },
  {
    id: 'es-modules',
    melding: 'Frontend gebruikt gewone <script>-tags, geen ES-modules (werkt anders niet via file://).',
    paden: /^hub\/frontend\/.*\.html$/,
    patroon: /<script\b[^>]*type=["']module["']/i,
  },
  {
    id: 'http-status',
    melding: 'Terugvalmelding via AquatechCommon.statusMessage(status), nooit `HTTP ${status}`.',
    paden: /^hub\/frontend\/.*\.js$/,
    nietIn: /\/vendor\//,
    patroon: /['"`]HTTP \$\{/,
  },
  {
    id: 'voorraad-direct',
    melding: 'Voorraad wijzigen alleen via stock.book, nooit on_hand rechtstreeks.',
    paden: /^hub\/backend\/src\/.*\.js$/,
    nietIn: /artikelen\/stock[^/]*\.js$|database\/pgschema\.js$/,
    patroon: /\bUPDATE\s+stock_items\s+SET\b[^;`'"]*\bon_hand\b/i,
  },
  {
    id: 'refund-direct',
    melding: 'Terugbetalen via webPayments.refund, nooit rechtstreeks mollie.createRefund.',
    paden: /^hub\/backend\/src\/.*\.js$/,
    nietIn: /webshop\/(web-payments|mollie)\.js$/,
    patroon: /\bmollie\.createRefund\(/,
  },
  {
    id: 'pakbon-direct',
    melding: 'Een pakbon van een bestelling via pdfFor, nooit packingSlipsPdf rechtstreeks.',
    paden: /^hub\/backend\/src\/.*\.js$/,
    nietIn: /webshop\/packing-slips\.js$/,
    patroon: /\bpackingSlipsPdf\(/,
  },
  {
    id: 'test-overslaan',
    melding: 'Nooit een test overslaan of isoleren om groen te worden (test.skip, .only).',
    paden: /^hub\/backend\/test\/.*\.js$/,
    patroon: /\b(?:test|it|describe)\.(?:skip|only)\(|\.only\(/,
  },
  {
    id: 'geheim',
    melding: 'Nooit secrets in de repo of in chat (sleutels alleen in Beheer > Instellingen).',
    paden: /.*/,
    nietIn: /^\.claude\/hooks\//,
    patroon: /sk-ant-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'modelnaam',
    melding: 'Geen modelnamen of -ID\'s in code, docs of commits.',
    paden: /.*/,
    nietIn: /^\.claude\//,
    patroon: new RegExp(`claude-(?:${MODEL})-[0-9]|\\b(?:${MODEL})[ -]?[0-9](?:\\.[0-9])\\b`, 'i'),
  },
  {
    id: 'csv',
    melding: 'Exports zijn Excel (.xlsx), geen CSV, tenzij Daniël daar expliciet om vraagt. Is dat zo, ga dan door.',
    niveau: 'warn',
    paden: /^hub\/(backend\/src|frontend)\/.*\.js$/,
    nietIn: /\/vendor\//,
    patroon: /text\/csv|\.csv['"`]|\bto[A-Z]?[Cc]sv\(/,
  },
  {
    id: 'nieuwe-dependency',
    melding: 'Nieuwe dependency? Loop eerst de beslisladder af (CLAUDE.md): bestaand, standaardbibliotheek, platform of een geïnstalleerde dependency. Zet de reden in de PR-beschrijving.',
    niveau: 'warn',
    paden: /^hub\/backend\/package\.json$/,
    patroon: /^\s*"(?!version")[@\w./-]+"\s*:\s*"[\^~]?\d+\.\d+/m,
  },
];

/** Bestanden die nooit met de hand worden aangepast (release.yml doet dat). */
export const RELEASE_FILES = {
  changelog: 'hub/CHANGELOG.md',
  releases: 'hub/frontend/nieuws/releases.js',
  packageJson: 'hub/backend/package.json',
};

/** Bestanden waarvan een wijziging eerst bevestigd moet worden. */
export const ASK_FILES = [
  { pad: /^\.github\/workflows\/claude-review\.yml$/, melding: 'Dit workflow-bestand bevat de verplichte Claude-reviews; zet ze nooit uit of over. Bevestig alleen als Daniël dit vroeg.' },
  { pad: /^\.claude\/(settings\.json|hooks\/)/, melding: 'Dit zijn de vangrails zelf; wijzig ze alleen op verzoek van Daniël.' },
];

/** Regels voor Bash-opdrachten: { id, melding, patroon }. */
export const BASH_RULES = [
  { id: 'admin-merge', melding: 'Geen admin-merge of bypass van de branch-protectie.', patroon: /\bgh\s+pr\s+merge\b[^|;&]*--admin\b/ },
  { id: 'beveiliging-wijzigen', melding: 'Branch-protectie en rulesets wijzigen is aan Daniël.', patroon: /\bgh\s+api\b[^|;&]*(?:-X|--method)\s*(?:PUT|PATCH|DELETE|POST)\b[^|;&]*\/(?:branches\/[^\s/]+\/protection|rulesets?)\b/i },
  { id: 'pkill', melding: 'Nooit pkill -f in de cloud-sandbox; stop een testserver met kill $(lsof -ti tcp:3300).', patroon: /\bpkill\b[^|;&]*\s-\w*f/ },
  { id: 'raw-github', melding: 'Ruwe GitHub-bestanden altijd op een vaste commit-SHA, nooit op een branch.', patroon: /raw\.githubusercontent\.com\/[^/\s]+\/[^/\s]+\/(?!(?:[0-9a-f]{40})\b)[^\s'"]+/i },
  { id: 'develop', melding: 'De branch develop bestaat niet meer (besluit Daniël 2026-11-25).', patroon: /\bgit\s+(?:push|checkout|switch|branch|merge)\b[^|;&]*\bdevelop\b/ },
  { id: 'modelnaam-commit', melding: 'Geen modelnamen of -ID\'s in commits of PR\'s (alleen de verplichte Co-Authored-By-regel).', patroon: new RegExp(`claude-(?:${MODEL})-[0-9]|\\b(?:${MODEL})[ -]?[0-9]\\.[0-9]`, 'i'), alleenBij: /\bgit\s+commit\b|\bgh\s+pr\s+(?:create|edit)\b/, negeerTekst: /Co-Authored-By:[^"'\r\n]*<noreply@anthropic\.com>/gi },
  { id: 'geheim', melding: 'Nooit secrets in de repo of in chat.', patroon: /sk-ant-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];
