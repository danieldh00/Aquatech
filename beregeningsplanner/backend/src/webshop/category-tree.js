// Categorieboom van de webshop: de indeling van aquatechshop.nl (hoofdcategorie →
// categorie → subcategorie, soms vijf niveaus diep) met intro en afbeelding per
// categorie. De webshop levert alleen platte categorienamen; een product wordt
// op naam aan de diepste passende categorie van de boom gehangen.

/** De standaardboom (Aquatechshop.nl): een lijst hoofdcategorieën met `group`, `children`, `intro` en `image`. */
const DEFAULT_TREE = require('./category-tree.json');

/**
 * Maakt van een categorienaam een vergelijkbare sleutel: kleine letters en cijfers,
 * zonder accenten, streepjes en leestekens (zodat "PE – tyleenleidingen" en
 * "PE - tyleenleidingen" gelijk zijn).
 * @param {*} name De categorienaam.
 * @returns {string} De sleutel.
 */
function normalizeName(name) {
  return String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' en ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Zoekindexen per boom (de boom verandert niet, dus eenmaal opbouwen). */
const indexes = new WeakMap();

/**
 * Zoekindex van een boom: genormaliseerde naam → de plek in de boom.
 * @param {object[]} tree De boom (zie DEFAULT_TREE).
 * @returns {Map<string, { node: object, group: string, depth: number, root: boolean }>} De index; de diepste plek wint bij gelijke namen.
 */
function indexOf(tree) {
  if (indexes.has(tree)) return indexes.get(tree);
  const index = new Map();
  /**
   * Zet een knoop en zijn kinderen in de index.
   * @param {object} node De knoop.
   * @param {string} group De hoofdcategorie (slug) waar de knoop onder valt.
   * @param {number} depth Diepte (0 = hoofdcategorie).
   * @returns {void}
   */
  const visit = (node, group, depth) => {
    const key = normalizeName(node.name);
    const known = index.get(key);
    if (!known || known.depth < depth) index.set(key, { node, group, depth, root: depth === 0 });
    for (const child of node.children || []) visit(child, group, depth + 1);
  };
  for (const root of tree) visit(root, root.group, 0);
  indexes.set(tree, index);
  return index;
}

/**
 * Zoekt uit een lijst categorienamen van een product de diepste plek in de boom.
 * @param {object[]} tree De boom.
 * @param {string[]} names De categorienamen van het product.
 * @returns {?{ node: object, group: string, depth: number, root: boolean }} De plek, of null als geen naam in de boom staat.
 */
function placeIn(tree, names) {
  const index = indexOf(tree);
  let best = null;
  for (const name of names) {
    const hit = index.get(normalizeName(name));
    if (hit && (!best || hit.depth > best.depth)) best = hit;
  }
  return best;
}

module.exports = { DEFAULT_TREE, normalizeName, placeIn };
