// Beheer > Sproeiers: de sproeierbibliotheek van de organisatie (behuizingen en
// nozzles met worp, sproeihoeken, drukbereik en debiet). Downloaden als Excel
// (de huidige bibliotheek is meteen het sjabloon), aangepast weer inlezen, of
// terug naar de standaard. Opslag en controle: backend/src/sprinklers.js.
(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nl = (v, d = 1) => (v == null || v === '' ? '' : Number(v).toLocaleString('nl-NL', { maximumFractionDigits: d }));
  const when = (iso) => (iso ? new Date(iso).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const Lib = window.SprinklerLib;
  let toast = () => {};
  let current = { own: null, updatedAt: null };

  async function api(opts = {}) {
    const res = await fetch('../api/sprinkler-library', {
      cache: 'no-store',
      ...opts,
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
    return body;
  }

  const lib = () => Lib.merge(current.own && Lib.sanitize(current.own));

  function render() {
    const l = lib();
    const own = current.own ? current.own.bodies.length + current.own.nozzles.length : 0;
    $('#sp-status').innerHTML = own
      ? `<b>${own}</b> eigen regel${own === 1 ? '' : 's'} bovenop de standaard${current.updatedAt ? `, ingelezen op ${esc(when(current.updatedAt))}` : ''}.`
      : 'De standaardbibliotheek is in gebruik (geen eigen regels).';
    $('#sp-reset').disabled = !own;
    const src = (x) => (x.source === 'eigen' ? '<span class="pill">eigen</span>' : '');
    $('#sp-bodies').innerHTML = `<thead><tr><th>Behuizing</th><th>Merk</th><th class="num">Pop-up</th><th>Aansluiting</th><th class="num">Drukregeling</th><th>Artikelcode</th><th></th></tr></thead>
      <tbody>${l.bodies.map((b) => `<tr><td>${esc(b.name)}</td><td>${esc(b.brand)}</td><td class="num">${b.popup ? `${b.popup} cm` : ''}</td>
        <td>${esc(Lib.MOUNTS[b.mount] || b.mount)}</td><td class="num">${b.regBar ? `${nl(b.regBar)} bar` : '–'}</td><td>${esc(b.code)}</td><td>${src(b)}</td></tr>`).join('')}</tbody>`;
    $('#sp-nozzles').innerHTML = `<thead><tr><th>Nozzle</th><th>Merk</th><th>Soort</th><th>Aansluiting</th><th>Sproeihoeken</th><th class="num">Worp</th><th class="num">Debiet</th><th></th></tr></thead>
      <tbody>${l.nozzles.map((n) => {
        const p = Lib.perfAt(n, n.bar);
        const r = Lib.radiusRange(n, n.bar);
        const arcs = n.arcs.map(([a, b]) => (a === b ? `${a}°` : `${a}–${b}°`)).join(' / ');
        return `<tr><td>${esc(n.name)}</td><td>${esc(n.brand)}</td><td>${esc(Lib.GROUPS[n.group] || n.group)}</td><td>${esc(Lib.MOUNTS[n.mount] || n.mount)}</td>
          <td>${esc(arcs)}</td><td class="num">${nl(r.rMin)}–${nl(r.rMax)} m</td>
          <td class="num">${nl(p.q / 60, 2)} l/min${n.matched ? ' bij 360°' : ''} · ${nl(n.bar)} bar</td><td>${src(n)}</td></tr>`;
      }).join('')}</tbody>`;
  }

  async function load() {
    try { current = await api(); render(); } catch (e) { toast(`Kan de sproeierbibliotheek niet laden: ${e.message}`, true); }
  }

  async function exportExcel() {
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel-export niet beschikbaar.', true); return; }
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Aquatech';
    wb.created = new Date();
    const uitleg = wb.addWorksheet('Uitleg');
    uitleg.getColumn(1).width = 120;
    Lib.UITLEG.forEach((line, i) => { const row = uitleg.addRow([line]); if (i === 0) row.font = { bold: true, size: 13 }; row.alignment = { wrapText: true }; });
    const data = Lib.toSheets(lib());
    for (const [name, cols] of Object.entries(Lib.SHEETS)) {
      const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = cols.map(([header, key, width]) => ({ header, key, width }));
      data[name].forEach((r) => ws.addRow(r));
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF172F5E' } };
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    }
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    a.download = 'sproeierbibliotheek.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /** Waarde van een cel als tekst of getal (formules: het resultaat, rich text: de tekst). */
  function cellValue(v) {
    if (v == null) return '';
    if (typeof v === 'object') {
      if ('result' in v) return v.result;
      if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
      if ('text' in v) return v.text;
    }
    return v;
  }

  async function importExcel(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Het bestand is te groot (max. 5 MB).', true); return; }
    if (!window.ExcelJS && !(window.AquatechCommon && await window.AquatechCommon.excel())) { toast('Excel inlezen niet beschikbaar.', true); return; }
    const out = $('#sp-result');
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      const sheets = {};
      for (const name of Object.keys(Lib.SHEETS)) {
        const ws = wb.worksheets.find((w) => w.name.trim().toLowerCase() === name.toLowerCase());
        if (!ws) continue;
        const rows = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
          const vals = [];
          for (let c = 1; c <= row.cellCount; c++) vals.push(cellValue(row.getCell(c).value));
          rows.push(vals);
        });
        sheets[name] = rows;
      }
      if (!sheets.Behuizingen && !sheets.Nozzles) throw new Error('geen bladen "Behuizingen" of "Nozzles" gevonden; gebruik het Excel-bestand van Downloaden als sjabloon.');
      const raw = Lib.fromSheets(sheets);
      const check = Lib.sanitize(raw);
      if (!confirm(`${check.bodies.length} behuizingen en ${check.nozzles.length} nozzles inlezen?${check.problems.length ? ` ${check.problems.length} regel(s) worden overgeslagen.` : ''} Dit vervangt alle eigen regels.`)) return;
      const res = await api({ method: 'PUT', body: raw });
      current = res;
      render();
      out.innerHTML = `<p>Ingelezen: <b>${res.counts.bodies}</b> behuizingen en <b>${res.counts.nozzles}</b> nozzles, waarvan <b>${res.counts.own}</b> anders dan de standaard (alleen die worden opgeslagen).</p>${res.problems.length
        ? `<details open><summary>Overgeslagen (${res.problems.length})</summary><ul>${res.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></details>` : ''}`;
      toast('Sproeierbibliotheek ingelezen');
    } catch (e) {
      out.innerHTML = `<p class="err">Inlezen mislukt: ${esc(e.message)}</p>`;
    } finally {
      $('#sp-file').value = '';
    }
  }

  async function reset() {
    if (!confirm('Alle eigen behuizingen en nozzles verwijderen en terug naar de standaardbibliotheek?')) return;
    try { current = await api({ method: 'DELETE' }); render(); $('#sp-result').innerHTML = ''; toast('Standaardbibliotheek hersteld'); } catch (e) { toast(e.message, true); }
  }

  function init(opts) {
    toast = opts.toast || toast;
    $('#sp-export').onclick = () => exportExcel().catch((e) => toast(`Export mislukt: ${e.message}`, true));
    $('#sp-import').onclick = () => $('#sp-file').click();
    $('#sp-file').onchange = (e) => importExcel(e.target.files[0]);
    $('#sp-reset').onclick = reset;
  }

  window.BeheerSproeiers = { init, load };
})();
