/* VISUTRA — "⬇ Excel" download on every data table.
   Loaded on every Billing / Buyer / tools page that shows data. It finds each
   data table (products, customers, invoices, stock, movements, SKU mappings,
   orders, purchases, reports …), adds a download button above it, and wraps
   it so wide tables scroll sideways on phones instead of breaking the layout.

   The file contains exactly what the table shows at that moment (so any
   search / filter you applied is respected):
     - dropdowns → the selected option's text
     - text boxes → their value
     - action buttons (Edit, Delete, Map …) → left out
     - numbers like "₹1,234.50" / "−3" → real numbers in Excel
   Needs SheetJS (XLSX); if a page doesn't load it, it's fetched on first click.

   Opt out for a table: add data-no-excel to it. Name the file/sheet with
   data-excel-name="Stock report". */
(function () {
  'use strict';
  const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';

  function loadXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = XLSX_URL; s.onload = () => resolve(window.XLSX); s.onerror = () => reject(new Error('Could not load the Excel library'));
      document.head.appendChild(s);
    });
  }

  function cellValue(td) {
    // Prefer form values, drop buttons/badges' decorative bits.
    const sel = td.querySelector('select');
    if (sel) { const o = sel.options[sel.selectedIndex]; return o && o.value !== '' ? o.text.replace(/^★\s*/, '') : ''; }
    const inp = td.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=hidden])');
    if (inp) return inp.value;
    const chk = td.querySelector('input[type=checkbox]');
    const clone = td.cloneNode(true);
    clone.querySelectorAll('button, .vt-xl-btn, script, style, svg').forEach(n => n.remove());
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    let text = clone.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim();
    if (!text && chk) text = chk.checked ? 'Yes' : 'No';
    return text;
  }
  function toNumber(s) {
    if (typeof s !== 'string') return s;
    const t = s.replace(/[₹,\s]/g, '').replace(/^[−–]/, '-');
    return /^-?\d+(\.\d+)?$/.test(t) && t.length < 16 ? Number(t) : s;
  }
  function isActionColumn(headerText, rows, i) {
    if (headerText) return false;
    // A header-less column whose cells are only buttons = the actions column.
    return rows.every(r => { const c = r.cells[i]; return !c || (c.querySelector('button') && !cellValue(c)); });
  }

  function tableName(table) {
    if (table.dataset.excelName) return table.dataset.excelName;
    const card = table.closest('.card, .vt-chart, section, details') || document;
    const h = card.querySelector('h2, h3, summary');
    let name = document.title || 'VISUTRA';
    if (h) { const c = h.cloneNode(true); c.querySelectorAll('.badge, button, .vt-xl-btn').forEach(n => n.remove()); name = c.textContent; }
    name = name.replace(/[📊⚠★]/gu, '');
    name = name.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').replace(/[\\\/?*\[\]:]/g, '').trim();
    return name.slice(0, 60) || 'VISUTRA';
  }

  async function exportTable(table, btn) {
    const old = btn.innerHTML;
    try {
      btn.disabled = true; btn.innerHTML = ICON + ' Preparing…';
      const XLSX = await loadXLSX();
      const headRow = table.tHead && table.tHead.rows.length ? table.tHead.rows[table.tHead.rows.length - 1] : null;
      const bodyRows = [...table.tBodies].flatMap(tb => [...tb.rows]).filter(r => r.style.display !== 'none' && !r.classList.contains('hidden'));
      const dataRows = bodyRows.filter(r => !(r.cells.length === 1 && r.cells[0].colSpan > 1)); // skip "No items yet" rows
      if (!dataRows.length) { alert('This table is empty — nothing to download.'); return; }
      const width = Math.max(...dataRows.map(r => r.cells.length), headRow ? headRow.cells.length : 0);
      const headers = headRow ? [...headRow.cells].map(c => c.textContent.trim()) : [];
      while (headers.length < width) headers.push('');
      const keep = headers.map((h, i) => !isActionColumn(h, dataRows, i));
      const aoa = [headers.filter((_, i) => keep[i]).map((h, i) => h || 'Column ' + (i + 1))];
      dataRows.forEach(r => {
        const row = [];
        for (let i = 0; i < width; i++) if (keep[i]) row.push(r.cells[i] ? toNumber(cellValue(r.cells[i])) : '');
        aoa.push(row);
      });
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = aoa[0].map((_, i) => ({ wch: Math.min(48, Math.max(8, ...aoa.map(r => String(r[i] == null ? '' : r[i]).split('\n')[0].length + 2))) }));
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) };
      const wb = XLSX.utils.book_new();
      const name = tableName(table);
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
      XLSX.writeFile(wb, `VISUTRA - ${name} - ${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      alert('Could not create the Excel file: ' + e.message);
    } finally { btn.disabled = false; btn.innerHTML = old; }
  }

  function enhance(table) {
    if (table.dataset.vtExcel || table.hasAttribute('data-no-excel')) return;
    if (!table.tBodies.length || table.closest('.modal-box, .no-excel, .sig-pad')) return;
    // Line-item entry grids (typing an invoice) aren't data lists.
    if (table.classList.contains('line-items')) return;
    table.dataset.vtExcel = '1';
    // Wrap for horizontal scrolling on small screens.
    if (!table.parentElement.classList.contains('vt-table-wrap') && !table.parentElement.classList.contains('vlc-tbl-wrap')) {
      const wrap = document.createElement('div');
      wrap.className = 'vt-table-wrap';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    }
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'vt-xl-btn'; btn.title = 'Download this table as an Excel file';
    btn.innerHTML = ICON + ' Excel';
    btn.addEventListener('click', () => exportTable(table, btn));
    const bar = document.createElement('div');
    bar.className = 'vt-xl-bar';
    bar.appendChild(btn);
    const anchor = table.closest('.vt-table-wrap, .vlc-tbl-wrap') || table;
    anchor.parentNode.insertBefore(bar, anchor);
  }
  function scan(root) { (root || document).querySelectorAll('table').forEach(enhance); }

  // Phones: the sidebar is a swipeable strip — keep the current page's tab in view.
  function showActiveTab() {
    const a = document.querySelector('.sidebar a.active');
    if (a && window.matchMedia && window.matchMedia('(max-width:900px)').matches) {
      const bar = a.parentElement;
      bar.scrollLeft = a.offsetLeft - (bar.clientWidth - a.offsetWidth) / 2;
    }
  }
  document.addEventListener('click', e => { if (e.target.closest && e.target.closest('.sidebar a')) setTimeout(showActiveTab, 50); });
  window.addEventListener('load', () => setTimeout(showActiveTab, 300));

  window.VTExcel = { exportTable, scan };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan());
  else scan();
  // Tables that appear later (tabs, dialogs, results) get a button too.
  new MutationObserver(muts => {
    for (const m of muts) m.addedNodes.forEach(n => { if (n.nodeType === 1) { if (n.tagName === 'TABLE') enhance(n); else if (n.querySelector) scan(n); } });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
