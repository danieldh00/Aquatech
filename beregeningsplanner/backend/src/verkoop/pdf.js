// Kleine PDF-schrijver zonder afhankelijkheden: A4-pagina's met tekst in de
// standaardletters Helvetica en Helvetica-Bold (WinAnsi, dus ook é, ë en €),
// vlakken, lijnen en een PNG-afbeelding (het logo). Genoeg voor een factuur
// als bijlage bij een e-mail; geen PDF-bibliotheek nodig (geen native
// modules, zie CLAUDE.md). Coördinaten in punten, (0,0) linksboven.
const zlib = require('zlib');

const A4 = { width: 595.28, height: 841.89 };

// Tekenbreedtes (per 1000 eenheden) van tekens 32..126 uit de AFM-bestanden.
const W_REGULAR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556,
  556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
  611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Unicode -> WinAnsi voor 0x80..0x9F; 0xA0..0xFF is gelijk aan Latin-1.
const WIN = { 0x20ac: 0x80, 0x201a: 0x82, 0x201e: 0x84, 0x2026: 0x85, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94,
  0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x2122: 0x99 };
const SUBST = { 0x2212: '-', 0x00a0: ' ', 0x202f: ' ', 0x2009: ' ', 0x2010: '-', 0x2011: '-' };

/**
 * Zet tekst om naar WinAnsi-codes; wat er niet in zit wordt een vraagteken.
 * @param {*} text De tekst.
 * @returns {number[]} De tekencodes.
 */
function encode(text) {
  const out = [];
  for (const ch of String(text == null ? '' : text).normalize('NFC')) {
    let codePoint = ch.codePointAt(0);
    if (SUBST[codePoint]) codePoint = SUBST[codePoint].codePointAt(0);
    if (codePoint === 9) codePoint = 32;
    if (codePoint >= 32 && codePoint <= 126) out.push(codePoint);
    else if (codePoint >= 0xa0 && codePoint <= 0xff) out.push(codePoint);
    else if (WIN[codePoint]) out.push(WIN[codePoint]);
    else if (codePoint >= 32) out.push(63);
  }
  return out;
}

// Breedte van een geaccentueerde letter = die van de letter zonder accent.
const BASE = {};
for (let charCode = 0xc0; charCode <= 0xff; charCode++) {
  const baseCode = String.fromCharCode(charCode).normalize('NFD')[0].charCodeAt(0);
  if (baseCode < 127) BASE[charCode] = baseCode;
}
/**
 * Breedte van een teken in duizendsten van de lettergrootte.
 * @param {number} code WinAnsi-code.
 * @param {boolean} bold Vet (Helvetica-Bold).
 * @returns {number} De breedte.
 */
function charWidth(code, bold) {
  const widths = bold ? W_BOLD : W_REGULAR;
  if (code >= 32 && code <= 126) return widths[code - 32];
  if (BASE[code]) return widths[BASE[code] - 32];
  if (code === 0x80 || code === 0x96) return 556;
  if (code === 0x97) return 1000;
  if (code === 0x95 || code === 0xb7) return bold ? 350 : 278;
  return 556;
}

/**
 * Breedte van een tekst in punten.
 * @param {string} text De tekst.
 * @param {number} size Lettergrootte in punten.
 * @param {boolean} [bold] Vet.
 * @returns {number} De breedte in punten.
 */
function textWidth(text, size, bold = false) {
  return (encode(text).reduce((total, code) => total + charWidth(code, bold), 0) * size) / 1000;
}

/**
 * Breekt een woord dat zelf te breed is hard af. Elk teken (grafeemcluster) wordt één keer
 * gemeten (lineair), zodat een lang woord geen rekenwerk in het kwadraat kost.
 * @param {string} word Het woord.
 * @param {number} width Beschikbare breedte in punten.
 * @param {number} size Lettergrootte in punten.
 * @param {boolean} bold Vet.
 * @returns {string[]} De stukken; elk past (behalve een los teken dat breder is dan de regel).
 */
function breakWord(word, width, size, bold) {
  const pieces = [];
  let piece = '';
  let pieceWidth = 0;
  // Per grafeemcluster (letter + combinerende tekens), zodat een accent niet
  // los van zijn letter op de volgende regel belandt.
  for (const [character] of word.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const characterWidth = textWidth(character, size, bold);
    if (piece && pieceWidth + characterWidth > width) {
      pieces.push(piece);
      piece = '';
      pieceWidth = 0;
    }
    piece += character;
    pieceWidth += characterWidth;
  }
  pieces.push(piece);
  return pieces;
}

/**
 * Breekt tekst af op woorden zodat elke regel binnen de breedte past (ook bij harde enters); een te lang woord wordt hard afgebroken.
 * @param {string} text De tekst.
 * @param {number} width Beschikbare breedte in punten.
 * @param {number} size Lettergrootte in punten.
 * @param {boolean} [bold] Vet.
 * @returns {string[]} De regels.
 */
function wrap(text, width, size, bold = false) {
  const lines = [];
  for (const para of String(text == null ? '' : text).split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      // Een woord dat zelf te lang is, hard afbreken; het laatste stuk begint de nieuwe regel.
      const pieces = textWidth(word, size, bold) > width ? breakWord(word, width, size, bold) : [word];
      lines.push(...pieces.slice(0, -1));
      line = pieces[pieces.length - 1];
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Maakt van tekencodes een PDF-tekststring (haakjes en backslash ontsnapt, andere tekens octaal).
 * @param {number[]} codes WinAnsi-codes.
 * @returns {string} De inhoud tussen ( en ).
 */
const escText = (codes) => codes.map((code) => (code === 40 || code === 41 || code === 92 ? `\\${String.fromCharCode(code)}`
  : code < 32 || code > 126 ? `\\${code.toString(8).padStart(3, '0')}` : String.fromCharCode(code))).join('');
/**
 * Getal met hooguit twee decimalen voor in de PDF.
 * @param {number} value Het getal.
 * @returns {string} Het getal als tekst.
 */
const pdfNumber = (value) => (Math.round(value * 100) / 100).toString();
/**
 * Kleur als PDF-kleurwaarden.
 * @param {string} hex Kleur als #rrggbb.
 * @returns {string} Drie getallen tussen 0 en 1 (zwart bij een ongeldige kleur).
 */
function rgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const colorValue = match ? parseInt(match[1], 16) : 0;
  return [(colorValue >> 16) & 255, (colorValue >> 8) & 255, colorValue & 255].map((channel) => pdfNumber(channel / 255)).join(' ');
}

/**
 * Zet een PNG (8 bits, RGB of RGBA, niet interlaced) om naar een PDF-beeld:
 * de kleuren en apart het alfakanaal als zacht masker.
 * @param {Buffer} buffer Het PNG-bestand.
 * @returns {{ width: number, height: number, color: Buffer, alpha: Buffer|null }|null} Ingepakte beelddata, of null bij een ander formaat.
 */
function pngImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buffer.length) {
    const chunkLength = buffer.readUInt32BE(pos);
    const kind = buffer.toString('latin1', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + chunkLength);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + chunkLength;
  }
  if (depth !== 8 || interlace || (type !== 2 && type !== 6) || !width || !height || width * height > 4e6) return null;
  const bytesPerPixel = type === 6 ? 4 : 3;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * bytesPerPixel;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filterType = raw[y * (stride + 1)];
    const sourceStart = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= bytesPerPixel ? pixels[row + x - bytesPerPixel] : 0;
      const up = y ? pixels[row - stride + x] : 0;
      const upLeft = x >= bytesPerPixel && y ? pixels[row - stride + x - bytesPerPixel] : 0;
      let value = raw[sourceStart + x];
      if (filterType === 1) value += left;
      else if (filterType === 2) value += up;
      else if (filterType === 3) value += (left + up) >> 1;
      else if (filterType === 4) {
        const estimate = left + up - upLeft, toLeft = Math.abs(estimate - left), toUp = Math.abs(estimate - up), toUpLeft = Math.abs(estimate - upLeft);
        value += toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      }
      pixels[row + x] = value & 255;
    }
  }
  const color = Buffer.alloc(width * height * 3);
  const alpha = type === 6 ? Buffer.alloc(width * height) : null;
  for (let i = 0; i < width * height; i++) {
    color[i * 3] = pixels[i * bytesPerPixel]; color[i * 3 + 1] = pixels[i * bytesPerPixel + 1]; color[i * 3 + 2] = pixels[i * bytesPerPixel + 2];
    if (alpha) alpha[i] = pixels[i * bytesPerPixel + 3];
  }
  return { width, height, color: zlib.deflateSync(color), alpha: alpha ? zlib.deflateSync(alpha) : null };
}

/**
 * Maakt een PDF-document: pagina's toevoegen, tekenen, en met toBuffer() de PDF.
 * @param {{ title?: string, author?: string }} [info] Titel en auteur in de documenteigenschappen.
 * @returns {object} addPage, setPage, text, rect, line, image, toBuffer, pageCount en A4.
 */
function createPdf({ title = '', author = '' } = {}) {
  const pages = [];
  const images = [];
  let page = null;

  /**
   * Begint een nieuwe pagina; tekenen gaat daarna op die pagina.
   * @returns {object} De pagina.
   */
  function addPage() {
    page = { ops: [] };
    pages.push(page);
    return page;
  }
  /**
   * Zet een afstand vanaf de bovenkant om naar PDF-coördinaten (die tellen vanaf de onderkant).
   * @param {number} top Afstand vanaf de bovenkant in punten.
   * @returns {number} De y-coördinaat in de PDF.
   */
  const y = (top) => A4.height - top;

  /**
   * Schrijft een regel tekst.
   * @param {string} content De tekst.
   * @param {number} x Horizontale positie (links, rechts of midden, volgens align).
   * @param {number} top Bovenkant van de regel.
   * @param {object} [style] size, bold, color en align (left|right|center).
   */
  function text(content, x, top, { size = 10, bold = false, color = '#1d2733', align = 'left' } = {}) {
    const codes = encode(content);
    if (!codes.length) return;
    let startX = x;
    const width = textWidth(content, size, bold);
    if (align === 'right') startX = x - width;
    else if (align === 'center') startX = x - width / 2;
    page.ops.push(`BT /${bold ? 'F2' : 'F1'} ${pdfNumber(size)} Tf ${rgb(color)} rg ${pdfNumber(startX)} ${pdfNumber(y(top + size * 0.8))} Td (${escText(codes)}) Tj ET`);
  }
  /**
   * Tekent een rechthoek, gevuld en/of met rand.
   * @param {number} x Linkerkant.
   * @param {number} top Bovenkant.
   * @param {number} width Breedte.
   * @param {number} height Hoogte.
   * @param {object} [style] fill, stroke (kleuren) en lineWidth.
   */
  function rect(x, top, width, height, { fill = null, stroke = null, lineWidth = 0.6 } = {}) {
    const ops = [];
    if (fill) ops.push(`${rgb(fill)} rg`);
    if (stroke) ops.push(`${rgb(stroke)} RG ${pdfNumber(lineWidth)} w`);
    ops.push(`${pdfNumber(x)} ${pdfNumber(y(top + height))} ${pdfNumber(width)} ${pdfNumber(height)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
    page.ops.push(`q ${ops.join(' ')} Q`);
  }
  /**
   * Tekent een lijn.
   * @param {number} x1 Begin, horizontaal.
   * @param {number} top1 Begin, afstand vanaf de bovenkant.
   * @param {number} x2 Eind, horizontaal.
   * @param {number} top2 Eind, afstand vanaf de bovenkant.
   * @param {object} [style] color en width.
   */
  function line(x1, top1, x2, top2, { color = '#d0d6de', width = 0.6 } = {}) {
    page.ops.push(`q ${rgb(color)} RG ${pdfNumber(width)} w ${pdfNumber(x1)} ${pdfNumber(y(top1))} m ${pdfNumber(x2)} ${pdfNumber(y(top2))} l S Q`);
  }
  /**
   * Plaatst een PNG-afbeelding; dezelfde afbeelding komt maar één keer in het bestand.
   * @param {Buffer} png De afbeelding.
   * @param {number} x Linkerkant.
   * @param {number} top Bovenkant.
   * @param {number} width Breedte.
   * @param {number} height Hoogte.
   * @returns {boolean} False als het formaat niet wordt ondersteund.
   */
  function image(png, x, top, width, height) {
    let img = images.find((entry) => entry.src === png);
    if (!img) {
      const parsed = pngImage(png);
      if (!parsed) return false;
      img = { src: png, name: `Im${images.length + 1}`, ...parsed };
      images.push(img);
    }
    page.ops.push(`q ${pdfNumber(width)} 0 0 ${pdfNumber(height)} ${pdfNumber(x)} ${pdfNumber(y(top + height))} cm /${img.name} Do Q`);
    return true;
  }

  /**
   * Schrijft het document: objecten, verwijzingstabel en trailer.
   * @returns {Buffer} Het PDF-bestand.
   */
  function toBuffer() {
    const objs = [];
    /**
     * Voegt een PDF-object toe.
     * @param {string|object|null} body Tekst, { dict, data } voor een stream, of null (later in te vullen).
     * @returns {number} Het objectnummer.
     */
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null);
    const pagesObj = add(null);
    const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const imageRefs = [];
    for (const img of images) {
      let smask = '';
      if (img.alpha) {
        const maskId = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, data: img.alpha });
        smask = ` /SMask ${maskId} 0 R`;
      }
      const id = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask}`, data: img.color });
      imageRefs.push(`/${img.name} ${id} 0 R`);
    }
    const kids = [];
    for (const pageEntry of pages) {
      const content = add({ dict: '<< /Filter /FlateDecode', data: zlib.deflateSync(Buffer.from(pageEntry.ops.join('\n'), 'latin1')) });
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${pdfNumber(A4.width)} ${pdfNumber(A4.height)}] /Contents ${content} 0 R `
        + `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >>${imageRefs.length ? ` /XObject << ${imageRefs.join(' ')} >>` : ''} >> >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((kidId) => `${kidId} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title (${escText(encode(title))}) /Author (${escText(encode(author))}) /Producer (Aquatech) >>`);

    const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let size = parts[0].length;
    const offsets = [];
    objs.forEach((object, i) => {
      offsets.push(size);
      const chunk = typeof object === 'string'
        ? Buffer.from(`${i + 1} 0 obj\n${object}\nendobj\n`, 'latin1')
        : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${object.dict} /Length ${object.data.length} >>\nstream\n`, 'latin1'), object.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      parts.push(chunk);
      size += chunk.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${size}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }

  /**
   * Gaat terug naar een eerdere pagina, bijv. om achteraf paginanummers te zetten.
   * @param {number} index Paginanummer (0 = eerste).
   */
  function setPage(index) {
    page = pages[index];
  }

  return { addPage, setPage, text, rect, line, image, toBuffer, get pageCount() { return pages.length; }, A4 };
}

module.exports = { createPdf, textWidth, wrap, encode, pngImage, A4 };
