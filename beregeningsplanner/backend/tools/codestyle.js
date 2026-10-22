// Codestijlcontrole: bewaakt de huisregels voor leesbare code (zie CLAUDE.md,
// "Codestijl"). Controleert elk eigen JavaScript-bestand (backend, tests en
// frontend, zonder vendor/) op:
//  - namen van één letter (alleen i/j als teller, x/y als coördinaat, _ voor
//    een ongebruikte parameter en $ als querySelector-hulp mogen);
//  - een commentaarblok (/** ... */) boven elke benoemde functie, met een
//    omschrijving, een @param per parameter en @returns als er iets terugkomt.
// Gebruik: `npm run codestyle` (alle bestanden) of
// `node tools/codestyle.js <bestand> ...` (alleen die bestanden).
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_DIRS = ['backend/src', 'backend/test', 'backend/tools', 'frontend'];
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'fixtures']);
const ALLOWED_SHORT_NAMES = new Set(['i', 'j', 'x', 'y', '_', '$']);
const BASELINE_FILE = path.join(__dirname, 'codestyle-baseline.json');

/**
 * Zoekt recursief alle eigen JavaScript-bestanden van de app.
 * @returns {string[]} Paden relatief aan beregeningsplanner/, met '/' als scheidingsteken.
 */
function listSourceFiles() {
  const found = [];
  /**
   * Loopt één map door en voegt de .js-bestanden toe aan `found`.
   * @param {string} relativeDir Map relatief aan beregeningsplanner/.
   * @returns {void}
   */
  const visit = (relativeDir) => {
    for (const entry of fs.readdirSync(path.join(APP_ROOT, relativeDir), { withFileTypes: true })) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(relativePath);
      } else if (entry.name.endsWith('.js')) {
        found.push(relativePath);
      }
    }
  };
  for (const dir of SOURCE_DIRS) if (fs.existsSync(path.join(APP_ROOT, dir))) visit(dir);
  return found.sort();
}

/**
 * Leest de lijst bestanden die nog niet zijn opgeschoond (en dus nog worden overgeslagen).
 * @returns {string[]} Paden relatief aan beregeningsplanner/.
 */
function readBaseline() {
  if (!fs.existsSync(BASELINE_FILE)) return [];
  return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).files || [];
}

/**
 * Parseert JavaScript-broncode tot een syntaxboom, met alle commentaren erbij.
 * @param {string} sourceText De inhoud van het bestand.
 * @returns {{ ast: object, comments: object[] }} De boom en de commentaren (met start/einde).
 */
function parseSource(sourceText) {
  const comments = [];
  const options = {
    ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true,
    locations: true, onComment: comments,
  };
  let ast;
  try {
    ast = acorn.parse(sourceText, { ...options, sourceType: 'script' });
  } catch (scriptError) {
    comments.length = 0;
    ast = acorn.parse(sourceText, { ...options, sourceType: 'module' });
  }
  return { ast, comments };
}

/**
 * Verzamelt alle identifiers die in een bindingspatroon worden gedeclareerd
 * (gewone naam, destructuring, standaardwaarde, rest).
 * @param {object} pattern Een patroonknoop uit de syntaxboom.
 * @param {object[]} identifiers Lijst waaraan de gevonden Identifier-knopen worden toegevoegd.
 * @returns {object[]} Dezelfde lijst `identifiers`.
 */
function collectBindingIdentifiers(pattern, identifiers = []) {
  if (!pattern) return identifiers;
  switch (pattern.type) {
    case 'Identifier': identifiers.push(pattern); break;
    case 'ObjectPattern':
      for (const property of pattern.properties) {
        collectBindingIdentifiers(property.type === 'RestElement' ? property.argument : property.value, identifiers);
      }
      break;
    case 'ArrayPattern': for (const element of pattern.elements) collectBindingIdentifiers(element, identifiers); break;
    case 'AssignmentPattern': collectBindingIdentifiers(pattern.left, identifiers); break;
    case 'RestElement': collectBindingIdentifiers(pattern.argument, identifiers); break;
    default: break;
  }
  return identifiers;
}

/**
 * Bepaalt of een functie iets teruggeeft: een pijlfunctie met een expressie
 * als body, of een `return <waarde>` die niet in een geneste functie staat.
 * @param {object} functionNode Een functieknoop uit de syntaxboom.
 * @returns {boolean} true als de functie een waarde teruggeeft.
 */
function returnsValue(functionNode) {
  if (functionNode.expression) return true;
  let found = false;
  /**
   * Doorzoekt een knoop en zijn kinderen op een return met waarde; zet `found`.
   * @param {object} node Knoop uit de syntaxboom.
   * @returns {void}
   */
  const search = (node) => {
    if (!node || found || typeof node.type !== 'string') return;
    if (node !== functionNode.body && /Function/.test(node.type)) return;
    if (node.type === 'ReturnStatement' && node.argument) { found = true; return; }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(search);
      else if (child && typeof child.type === 'string') search(child);
    }
  };
  search(functionNode.body);
  return found;
}

/**
 * Zoekt het /** ... *\/-commentaar dat direct (alleen witruimte ertussen) vóór een positie staat.
 * @param {string} sourceText De inhoud van het bestand.
 * @param {object[]} comments Alle commentaren van het bestand, op volgorde.
 * @param {number} position Beginpositie van de knoop die het commentaar hoort te hebben.
 * @returns {string|null} De tekst van het commentaar, of null als er geen is.
 */
function docCommentBefore(sourceText, comments, position) {
  let candidate = null;
  for (const comment of comments) {
    if (comment.end > position) break;
    candidate = comment;
  }
  if (!candidate || candidate.type !== 'Block' || !candidate.value.startsWith('*')) return null;
  if (sourceText.slice(candidate.end, position).trim() !== '') return null;
  return candidate.value;
}

/**
 * Haalt een type tussen accolades ({...}, ook genest) van het begin van een tag-tekst af.
 * @param {string} text Tekst na de tag, bijv. '{{ id: string }} options Uitleg'.
 * @returns {string} De tekst zonder het type en de witruimte erna.
 */
function stripType(text) {
  if (!text.startsWith('{')) return text;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') depth -= 1;
    if (depth === 0) return text.slice(i + 1).trimStart();
  }
  return text;
}

/**
 * Controleert of een commentaarblok de functie volledig beschrijft.
 * @param {string} docText Tekst van het commentaar (zonder /** en *\/).
 * @param {object} functionNode De functieknoop waar het commentaar bij hoort.
 * @returns {string[]} Gevonden tekortkomingen; leeg als het commentaar in orde is.
 */
function docProblems(docText, functionNode) {
  const problems = [];
  const lines = docText.split('\n').map((line) => line.replace(/^\s*\*?\s?/, '').trim());
  const descriptionLines = lines.filter((line) => line && !line.startsWith('@'));
  if (!descriptionLines.length) problems.push('omschrijving ontbreekt');
  const paramTags = lines.filter((line) => /^@param\b/.test(line))
    .map((line) => (stripType(line.replace(/^@param\s*/, '')).match(/^\[?([\w$.]+)/) || [])[1] || '')
    .filter((name) => name && !name.includes('.'));
  if (paramTags.length < functionNode.params.length) {
    problems.push(`@param ontbreekt (${functionNode.params.length} parameter(s), ${paramTags.length} beschreven)`);
  }
  if (returnsValue(functionNode) && !lines.some((line) => /^@returns?\b/.test(line))) problems.push('@returns ontbreekt');
  return problems;
}

/**
 * Geeft de naam van een sleutel in een object of klasse (alleen als die vast is).
 * @param {object} keyNode De sleutelknoop.
 * @param {boolean} computed true bij een berekende sleutel ([expressie]).
 * @returns {string} De naam, of '' als die niet vast te stellen is.
 */
function keyName(keyNode, computed) {
  if (computed) return '';
  if (keyNode.type === 'Identifier') return keyNode.name;
  if (keyNode.type === 'Literal') return String(keyNode.value);
  return '';
}

/**
 * Bepaalt of een object-literal een "eigen" object is (toegewezen, teruggegeven
 * of geëxporteerd) en geen optie-object dat als argument wordt meegegeven.
 * @param {object} parent De ouderknoop van het object.
 * @returns {boolean} true als functies in dit object een commentaarblok moeten hebben.
 */
function isNamedObjectParent(parent) {
  return !!parent && ['VariableDeclarator', 'AssignmentExpression', 'ReturnStatement', 'ExportDefaultDeclaration'].includes(parent.type);
}

/**
 * Controleert één bestand op de codestijlregels.
 * @param {string} sourceText De inhoud van het bestand.
 * @returns {{ line: number, message: string }[]} Alle overtredingen, op regelnummer.
 */
function checkSource(sourceText) {
  const { ast, comments } = parseSource(sourceText);
  const violations = [];
  /**
   * Meldt een naam van één letter (tenzij toegestaan).
   * @param {object} identifier De Identifier-knoop.
   * @param {string} kind Soort naam voor de melding (variabele, parameter, ...).
   * @returns {void}
   */
  const reportName = (identifier, kind) => {
    if (identifier.name.length === 1 && !ALLOWED_SHORT_NAMES.has(identifier.name)) {
      violations.push({ line: identifier.loc.start.line, message: `${kind} '${identifier.name}' heeft een naam van één letter` });
    }
  };
  /**
   * Meldt een ontbrekend of onvolledig commentaarblok boven een functie.
   * @param {object} functionNode De functieknoop.
   * @param {object} anchorNode De knoop waar het commentaar direct boven hoort (declaratie, eigenschap, ...).
   * @param {string} name Naam van de functie voor de melding.
   * @returns {void}
   */
  const requireDoc = (functionNode, anchorNode, name) => {
    const docText = docCommentBefore(sourceText, comments, anchorNode.start);
    const line = anchorNode.loc.start.line;
    if (docText == null) {
      violations.push({ line, message: `functie '${name}' heeft geen commentaarblok (/** ... */)` });
      return;
    }
    for (const problem of docProblems(docText, functionNode)) violations.push({ line, message: `functie '${name}': ${problem}` });
  };
  /**
   * Controleert de naam en de parameternamen van een functie.
   * @param {object} functionNode De functieknoop.
   * @returns {void}
   */
  const checkFunctionNames = (functionNode) => {
    if (functionNode.id) reportName(functionNode.id, 'functie');
    for (const param of functionNode.params) {
      for (const identifier of collectBindingIdentifiers(param)) reportName(identifier, 'parameter');
    }
  };

  walk.ancestor(ast, {
    VariableDeclarator(node) {
      for (const identifier of collectBindingIdentifiers(node.id)) reportName(identifier, 'variabele');
    },
    CatchClause(node) {
      for (const identifier of collectBindingIdentifiers(node.param)) reportName(identifier, 'foutvariabele');
    },
    ClassDeclaration(node) { if (node.id) reportName(node.id, 'klasse'); },
    FunctionDeclaration(node, ancestors) {
      checkFunctionNames(node);
      const parent = ancestors[ancestors.length - 2];
      const anchor = parent && /^Export/.test(parent.type) ? parent : node;
      requireDoc(node, anchor, node.id ? node.id.name : 'default');
    },
    FunctionExpression(node, ancestors) { checkNamedFunction(node, ancestors); },
    ArrowFunctionExpression(node, ancestors) { checkNamedFunction(node, ancestors); },
  });

  /**
   * Controleert een functie-expressie of pijlfunctie: namen altijd, het
   * commentaarblok alleen als de functie een naam krijgt (variabele, eigenschap,
   * methode of toewijzing) en dus geen losse callback is. Een functie in een
   * object op één regel (`return { list, size: () => items.size }`) telt als
   * callback.
   * @param {object} node De functieknoop.
   * @param {object[]} ancestors De ouderknopen, met de functie zelf als laatste.
   * @returns {void}
   */
  function checkNamedFunction(node, ancestors) {
    checkFunctionNames(node);
    const parent = ancestors[ancestors.length - 2];
    const grandparent = ancestors[ancestors.length - 3];
    if (!parent) return;
    if (parent.type === 'VariableDeclarator' && parent.init === node && parent.id.type === 'Identifier') {
      const anchor = grandparent && grandparent.declarations.length === 1 ? grandparent : parent;
      const exportParent = ancestors[ancestors.length - 4];
      requireDoc(node, exportParent && /^Export/.test(exportParent.type) ? exportParent : anchor, parent.id.name);
    } else if (parent.type === 'MethodDefinition') {
      requireDoc(node, parent, keyName(parent.key, parent.computed) || 'methode');
    } else if (parent.type === 'Property' && parent.value === node && !parent.shorthand) {
      const objectNode = ancestors[ancestors.length - 3];
      const objectParent = ancestors[ancestors.length - 4];
      const singleLine = objectNode.loc.start.line === objectNode.loc.end.line;
      if (isNamedObjectParent(objectParent) && !singleLine) requireDoc(node, parent, keyName(parent.key, parent.computed) || 'methode');
    } else if (parent.type === 'AssignmentExpression' && parent.right === node && grandparent && grandparent.type === 'ExpressionStatement') {
      const target = parent.left.type === 'MemberExpression' ? keyName(parent.left.property, parent.left.computed) : parent.left.name;
      requireDoc(node, grandparent, target || 'functie');
    }
  }

  return violations.sort((left, right) => left.line - right.line);
}

/**
 * Controleert een bestand van de app op de codestijlregels.
 * @param {string} relativePath Pad relatief aan beregeningsplanner/.
 * @returns {{ line: number, message: string }[]} Alle overtredingen in dat bestand.
 */
function checkFile(relativePath) {
  return checkSource(fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8'));
}

module.exports = { APP_ROOT, listSourceFiles, readBaseline, checkSource, checkFile };

if (require.main === module) {
  const requested = process.argv.slice(2).map((file) => path.relative(APP_ROOT, path.resolve(file)).split(path.sep).join('/'));
  const baseline = new Set(readBaseline());
  const files = requested.length ? requested : listSourceFiles().filter((file) => !baseline.has(file));
  let total = 0;
  for (const file of files) {
    for (const violation of checkFile(file)) {
      total += 1;
      console.log(`${file}:${violation.line}  ${violation.message}`);
    }
  }
  console.log(total ? `${total} overtreding(en).` : 'Geen overtredingen.');
  process.exitCode = total ? 1 : 0;
}
