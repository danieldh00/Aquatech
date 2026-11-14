// Een kleine Excel-schrijver (.xlsx) zonder bibliotheek: tabbladen met een kopregel, tekst, getallen en datums.
// Een .xlsx is een zip met een paar XML-bestanden; de zip maken we hier zelf met zlib (deflate + CRC32).
// Gebruikt door de AI-koppeling (mcp-tools.js) voor rapporten; de browser gebruikt voor zijn eigen exports ExcelJS.
const zlib = require('zlib');

/** Hoeveel rijen een tabblad hoogstens krijgt (Excel kan er 1.048.576). */
const MAX_ROWS = 20000;
/** Hoeveel tekens een cel hoogstens krijgt (Excel: 32.767). */
const MAX_CELL_LENGTH = 5000;

/**
 * Maakt tekst veilig voor XML (stuurtekens weg, speciale tekens vervangen).
 * @param {*} value De tekst.
 * @returns {string} De veilige tekst.
 */
const escapeXml = (value) => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * De Excel-naam van een kolom (0 = A, 26 = AA).
 * @param {number} index Kolomnummer vanaf 0.
 * @returns {string} De kolomletters.
 */
function columnName(index) {
  let name = '';
  let rest = index;
  do {
    name = String.fromCharCode(65 + (rest % 26)) + name;
    rest = Math.floor(rest / 26) - 1;
  } while (rest >= 0);
  return name;
}

/**
 * Een celwaarde die Excel als formule zou lezen krijgt een apostrof ervoor, zodat gegevens van klanten nooit als formule draaien.
 * @param {string} text De tekst.
 * @returns {string} De veilige tekst.
 */
const neutralizeFormula = (text) => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);

/**
 * De XML van één cel. Getallen blijven getallen; datums (JJJJ-MM-DD) worden Excel-datums; de rest is tekst.
 * @param {*} value De waarde.
 * @param {string} reference Het celadres (A1).
 * @param {{ type?: string }} column De kolom (type: text, number, money, date).
 * @param {boolean} header Of het de kopregel is.
 * @returns {string} De XML van de cel ('' bij een lege waarde).
 */
function cellXml(value, reference, column, header) {
  if (value == null || value === '') return '';
  if (header) return `<c r="${reference}" s="1" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
  if ((column.type === 'number' || column.type === 'money') && Number.isFinite(Number(value))) {
    return `<c r="${reference}" s="${column.type === 'money' ? 3 : 0}"><v>${Number(value)}</v></c>`;
  }
  if (column.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    const days = Math.round(Date.parse(`${value}T00:00:00Z`) / 86400000) + 25569;
    if (Number.isFinite(days)) return `<c r="${reference}" s="2"><v>${days}</v></c>`;
  }
  const text = neutralizeFormula(String(value).slice(0, MAX_CELL_LENGTH));
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
}

/**
 * De XML van een tabblad: kopregel (vet, vastgezet) en de rijen.
 * @param {{ columns: { header: string, key: string, width?: number, type?: string }[], rows: object[] }} sheet Het tabblad.
 * @returns {string} De XML.
 */
function sheetXml(sheet) {
  const rows = sheet.rows.slice(0, MAX_ROWS);
  const lines = [`<row r="1">${sheet.columns.map((column, index) => cellXml(column.header, `${columnName(index)}1`, column, true)).join('')}</row>`];
  rows.forEach((row, rowIndex) => {
    const number = rowIndex + 2;
    lines.push(`<row r="${number}">${sheet.columns.map((column, index) => cellXml(row[column.key], `${columnName(index)}${number}`, column, false)).join('')}</row>`);
  });
  const lastColumn = columnName(Math.max(0, sheet.columns.length - 1));
  const widths = sheet.columns.map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${Math.min(60, Math.max(8, column.width || 16))}" customWidth="1"/>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + `<cols>${widths}</cols><sheetData>${lines.join('')}</sheetData>`
    + `<autoFilter ref="A1:${lastColumn}${Math.max(1, rows.length + 1)}"/></worksheet>`;
}

/** De opmaak: 0 standaard, 1 kop (vet), 2 datum, 3 bedrag met twee decimalen. */
const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>'
  + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
  + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
  + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
  + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
  + '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
  + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

/**
 * Een geldige tabbladnaam (Excel: hoogstens 31 tekens, zonder : \ / ? * [ ]).
 * @param {string} name De gewenste naam.
 * @param {number} index Volgnummer, voor een eigen naam bij een lege naam.
 * @returns {string} De naam.
 */
const sheetName = (name, index) => String(name || '').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || `Blad ${index + 1}`;

/**
 * Maakt een zip van de bestanden (deflate), zoals Excel hem verwacht.
 * @param {{ name: string, data: Buffer }[]} files De bestanden.
 * @returns {Buffer} De zip.
 */
function zip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const packed = zlib.deflateRawSync(file.data);
    const checksum = zlib.crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(file.data.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12); entry.writeUInt16LE(0x21, 14); entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(file.data.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directoryBuffer = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBuffer, end]);
}

/**
 * Bouwt een Excel-werkmap.
 * @param {{ name: string, columns: { header: string, key: string, width?: number, type?: 'text'|'number'|'money'|'date' }[], rows: object[] }[]} sheets De tabbladen (minstens één).
 * @returns {Buffer} De inhoud van het .xlsx-bestand.
 */
function buildWorkbook(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('Een werkmap heeft minstens één tabblad nodig.');
  const names = sheets.map((sheet, index) => sheetName(sheet.name, index));
  /**
   * De XML als bytes.
   * @param {string} xml De tekst.
   * @returns {Buffer} De bytes.
   */
  const text = (xml) => Buffer.from(xml, 'utf8');
  const files = [
    { name: '[Content_Types].xml', data: text('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '</Types>') },
    { name: '_rels/.rels', data: text('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
    { name: 'xl/workbook.xml', data: text('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + names.map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('') + '</sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: text('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: text(STYLES_XML) },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: text(sheetXml(sheet)) })),
  ];
  return zip(files);
}

module.exports = { buildWorkbook, columnName, MAX_ROWS };
