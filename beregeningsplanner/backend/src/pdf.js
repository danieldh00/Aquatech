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

/** Tekst naar WinAnsi-codes; wat er niet in zit wordt een vraagteken. */
function encode(text) {
  const out = [];
  for (const ch of String(text == null ? '' : text).normalize('NFC')) {
    let cp = ch.codePointAt(0);
    if (SUBST[cp]) cp = SUBST[cp].codePointAt(0);
    if (cp === 9) cp = 32;
    if (cp >= 32 && cp <= 126) out.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else if (WIN[cp]) out.push(WIN[cp]);
    else if (cp >= 32) out.push(63);
  }
  return out;
}

// Breedte van een geaccentueerde letter = die van de letter zonder accent.
const BASE = {};
for (let c = 0xc0; c <= 0xff; c++) {
  const b = String.fromCharCode(c).normalize('NFD')[0].charCodeAt(0);
  if (b < 127) BASE[c] = b;
}
function charWidth(code, bold) {
  const w = bold ? W_BOLD : W_REGULAR;
  if (code >= 32 && code <= 126) return w[code - 32];
  if (BASE[code]) return w[BASE[code] - 32];
  if (code === 0x80 || code === 0x96) return 556;
  if (code === 0x97) return 1000;
  if (code === 0x95 || code === 0xb7) return bold ? 350 : 278;
  return 556;
}

/** Breedte van een tekst in punten. */
function textWidth(text, size, bold = false) {
  return (encode(text).reduce((s, c) => s + charWidth(c, bold), 0) * size) / 1000;
}

/** Breekt tekst af op woorden zodat elke regel binnen width past (ook bij harde enters). */
function wrap(text, width, size, bold = false) {
  const lines = [];
  for (const para of String(text == null ? '' : text).split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width || !line) {
        line = next;
        // Een woord dat zelf te lang is, hard afbreken.
        while (textWidth(line, size, bold) > width && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && textWidth(line.slice(0, cut), size, bold) > width) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

const escText = (codes) => codes.map((c) => (c === 40 || c === 41 || c === 92 ? `\\${String.fromCharCode(c)}`
  : c < 32 || c > 126 ? `\\${c.toString(8).padStart(3, '0')}` : String.fromCharCode(c))).join('');
const n = (v) => (Math.round(v * 100) / 100).toString();
function rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  const v = m ? parseInt(m[1], 16) : 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => n(c / 255)).join(' ');
}

/**
 * PNG (8 bits, RGB of RGBA, niet interlaced) omzetten naar een PDF-beeld:
 * de kleuren en apart het alfakanaal als zachte masker. Anders null.
 */
function pngImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8;
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace || (type !== 2 && type !== 6) || !width || !height || width * height > 4e6) return null;
  const bpp = type === 6 ? 4 : 3;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return null;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[row + x - bpp] : 0;
      const b = y ? px[row - stride + x] : 0;
      const c = x >= bpp && y ? px[row - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[row + x] = v & 255;
    }
  }
  const color = Buffer.alloc(width * height * 3);
  const alpha = type === 6 ? Buffer.alloc(width * height) : null;
  for (let i = 0; i < width * height; i++) {
    color[i * 3] = px[i * bpp]; color[i * 3 + 1] = px[i * bpp + 1]; color[i * 3 + 2] = px[i * bpp + 2];
    if (alpha) alpha[i] = px[i * bpp + 3];
  }
  return { width, height, color: zlib.deflateSync(color), alpha: alpha ? zlib.deflateSync(alpha) : null };
}

/** Een document: pagina's toevoegen, tekenen, en met toBuffer() de PDF. */
function createPdf({ title = '', author = '' } = {}) {
  const pages = [];
  const images = [];
  let page = null;

  function addPage() {
    page = { ops: [] };
    pages.push(page);
    return page;
  }
  const y = (top) => A4.height - top;

  /** Tekst; top = bovenkant van de regel. opts: size, bold, color, align (left|right|center), width. */
  function text(str, x, top, { size = 10, bold = false, color = '#1d2733', align = 'left' } = {}) {
    const codes = encode(str);
    if (!codes.length) return;
    let tx = x;
    const w = textWidth(str, size, bold);
    if (align === 'right') tx = x - w;
    else if (align === 'center') tx = x - w / 2;
    page.ops.push(`BT /${bold ? 'F2' : 'F1'} ${n(size)} Tf ${rgb(color)} rg ${n(tx)} ${n(y(top + size * 0.8))} Td (${escText(codes)}) Tj ET`);
  }
  function rect(x, top, w, h, { fill = null, stroke = null, lineWidth = 0.6 } = {}) {
    const ops = [];
    if (fill) ops.push(`${rgb(fill)} rg`);
    if (stroke) ops.push(`${rgb(stroke)} RG ${n(lineWidth)} w`);
    ops.push(`${n(x)} ${n(y(top + h))} ${n(w)} ${n(h)} re ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
    page.ops.push(`q ${ops.join(' ')} Q`);
  }
  function line(x1, top1, x2, top2, { color = '#d0d6de', width = 0.6 } = {}) {
    page.ops.push(`q ${rgb(color)} RG ${n(width)} w ${n(x1)} ${n(y(top1))} m ${n(x2)} ${n(y(top2))} l S Q`);
  }
  /** PNG-afbeelding (Buffer); geeft false als het formaat niet wordt ondersteund. */
  function image(png, x, top, w, h) {
    let img = images.find((i) => i.src === png);
    if (!img) {
      const parsed = pngImage(png);
      if (!parsed) return false;
      img = { src: png, name: `Im${images.length + 1}`, ...parsed };
      images.push(img);
    }
    page.ops.push(`q ${n(w)} 0 0 ${n(h)} ${n(x)} ${n(y(top + h))} cm /${img.name} Do Q`);
    return true;
  }

  function toBuffer() {
    const objs = [];
    const add = (body) => { objs.push(body); return objs.length; };
    const catalog = add(null);
    const pagesObj = add(null);
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const xobj = [];
    for (const img of images) {
      let smask = '';
      if (img.alpha) {
        const m = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, data: img.alpha });
        smask = ` /SMask ${m} 0 R`;
      }
      const id = add({ dict: `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${smask}`, data: img.color });
      xobj.push(`/${img.name} ${id} 0 R`);
    }
    const kids = [];
    for (const p of pages) {
      const content = add({ dict: '<< /Filter /FlateDecode', data: zlib.deflateSync(Buffer.from(p.ops.join('\n'), 'latin1')) });
      kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${n(A4.width)} ${n(A4.height)}] /Contents ${content} 0 R `
        + `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xobj.length ? ` /XObject << ${xobj.join(' ')} >>` : ''} >> >>`));
    }
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    const info = add(`<< /Title (${escText(encode(title))}) /Author (${escText(encode(author))}) /Producer (Aquatech) >>`);

    const parts = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
    let size = parts[0].length;
    const offsets = [];
    objs.forEach((o, i) => {
      offsets.push(size);
      const chunk = typeof o === 'string'
        ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1')
        : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict} /Length ${o.data.length} >>\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
      parts.push(chunk);
      size += chunk.length;
    });
    const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
    parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${size}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }

  /** Terug naar pagina i (0 = eerste), bijv. om achteraf paginanummers te zetten. */
  function setPage(i) {
    page = pages[i];
  }

  return { addPage, setPage, text, rect, line, image, toBuffer, get pageCount() { return pages.length; }, A4 };
}

module.exports = { createPdf, textWidth, wrap, encode, pngImage, A4 };
