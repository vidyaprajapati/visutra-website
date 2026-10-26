// VISUTRA — "latest entry first" + "Sort by" for every list of entered data.
// -------------------------------------------------------------------------
// • Every list below opens with the NEWEST ENTRY at the top (the time the record was first
//   saved, remembered by the database adapter) — so what you just entered is what you see first.
//   Ledgers / statements (running balance) open newest DATE first.
// • A "Sort by" box above each list: latest / oldest entry, date, and every column
//   (A → Z, high → low, newest …).
// • Lists redraw themselves all the time (live updates, filters) — the chosen order is
//   re-applied automatically after every redraw.
// • Entry forms (line items, carts) and computed reports (GSTR tables, stock reports) are
//   deliberately NOT touched. Add `data-vt-sort` to any other <table> to include it, and
//   `data-vt-statement` for a ledger. Call vtEnhanceTables() after drawing new tables.
(function (global) {
  'use strict';

  // tbody ids of the lists of entered data (seller Billing + Buyer + Order Receive pages)
  var LISTS = [
    'productsTable', 'customersTable', 'suppliersTable', 'purchaseProductsTable', 'skuMappingsTable', 'labelSkuQueueTable',
    'purchasesTable', 'paymentsEntryTable', 'invoicesTable', 'receiptsEntryTable', 'paymentsTable',
    'payablesTable', 'receivablesTable', 'duesTable',
    'paymentConfirmTable', 'invoiceDelFromBuyerTable', 'paymentDeleteTable', 'orderConfirmTable', 'deleteRequestsTable', 'payDeleteRequestsTable',
    'trashPurchasesTable', 'trashPaymentsTable', 'trashInvoicesTable',
    'stockTable', 'stockMovementsTable', 'dailyStockMovementTable', 'movementsTable', 'suRecent',
    'pgRegisterTable', 'pgItemsTable', 'registerTable', 'itemsTable',
    'ordersTable', 'recentOrdersTable', 'sellersTable', 'offPlatformTable',
    'productCatalogTable', 'mappingsTable', 'unmappedTable', 'packagingTable',
    'dashTable', 'custDashTable', 'ledgerTable'
  ];
  var STATEMENTS = ['dashTable', 'custDashTable', 'ledgerTable'];   // running-balance ledgers: newest DATE first

  var ctxs = [];   // one per enhanced table

  function norm(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim(); }

  /* ---------- value parsing ---------- */
  var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function parseDate(t) {
    t = norm(t);
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = /^(\d{1,2})-(\d{1,2})-(\d{4})/.exec(t);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
    m = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4})/.exec(t);
    if (m && MONTHS[m[2].toLowerCase()] != null) return Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    return null;
  }
  function parseNum(t) {
    t = norm(t).replace(/^[−–]/, '-');
    var m = /^([-+]?)\s*₹?\s*([\d,]+(?:\.\d+)?)\s*(?:%|[A-Za-z]{1,5})?$/.exec(t);
    return m ? parseFloat((m[1] === '-' ? '-' : '') + m[2].replace(/,/g, '')) : null;
  }
  function cellRaw(tr, i) {
    var c = tr.cells[i];
    if (!c) return '';
    return c.getAttribute('data-sort') != null ? c.getAttribute('data-sort') : norm(c.textContent);
  }
  function colType(rows, i) {
    var vals = rows.map(function (r) { return cellRaw(r, i); }).filter(function (v) { return v !== ''; });
    if (!vals.length) return 'none';
    var d = vals.filter(function (v) { return parseDate(v) != null; }).length;
    if (d / vals.length >= 0.7) return 'date';
    var n = vals.filter(function (v) { return parseNum(v) != null; }).length;
    if (n / vals.length >= 0.7) return 'num';
    return 'text';
  }
  function headerLabel(th) {
    var first = th.childNodes[0];
    var t = norm(first && first.nodeType === 3 ? first.textContent : th.textContent);
    return t || norm(th.textContent);
  }

  /* ---------- the row's own entry time (from the adapter's id → created-at memory) ---------- */
  function entryTime(tr) {
    if (tr._vtE !== undefined) return tr._vtE;
    var reg = global.vtCreated || {}, best = null;
    var toks = tr.outerHTML.match(/[A-Za-z0-9]{8,40}/g) || [];   // record ids are letters+digits (order-row-<id>, '<id>' …)
    for (var i = 0; i < toks.length; i++) {
      var v = reg[toks[i]];
      // a row also mentions older records (its supplier, product …); its OWN record is the newest of them
      if (v != null && (best == null || v > best)) best = v;
    }
    return (tr._vtE = best);
  }

  function isPinned(tr) {   // "No … yet" rows, total rows: stay put at the end
    for (var i = 0; i < tr.cells.length; i++) if (tr.cells[i].colSpan > 1) return true;
    return false;
  }

  function pickDateCol(headers, types) {
    var prefs = [/deleted/i, /^date$/i, /date/i, /generated|created|updated|detected|printed|first/i];
    for (var p = 0; p < prefs.length; p++)
      for (var i = 0; i < headers.length; i++) if (types[i] === 'date' && prefs[p].test(headers[i])) return i;
    for (var j = 0; j < headers.length; j++) if (types[j] === 'date') return j;
    return -1;
  }

  /* ---------- sorting ---------- */
  function cmpNullLast(a, b, dir) {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return (a < b ? -1 : a > b ? 1 : 0) * dir;
  }
  // Put the "Sort by" box on the same row as the table's Excel button (when it has one).
  function dock(ctx) {
    if (ctx.docked) return;
    var anchor = ctx.table.closest('.vt-table-wrap, .vlc-tbl-wrap') || ctx.table;
    var prev = anchor.previousElementSibling;
    if (!prev || !prev.classList.contains('vt-xl-bar')) return;
    prev.style.justifyContent = 'space-between'; prev.style.alignItems = 'center'; prev.style.gap = '10px';
    prev.insertBefore(ctx.label, prev.firstChild);
    ctx.bar.remove(); ctx.docked = true;
  }
  function apply(ctx) {
    dock(ctx);
    var rows = Array.prototype.slice.call(ctx.tbody.rows);
    var pinned = rows.filter(isPinned);
    var data = rows.filter(function (r) { return !isPinned(r); });
    data.forEach(function (r) { if (r._vtI === undefined) r._vtI = ctx.seq++; });
    var headers = ctx.headers, types = headers.map(function (h, i) { return colType(data, i); });
    var dateCol = pickDateCol(headers, types);
    var sig = types.join(',') + '|' + dateCol;
    if (sig !== ctx.sig) { ctx.sig = sig; buildOptions(ctx, types, dateCol); }

    var withEntry = data.filter(function (r) { return entryTime(r) != null; }).length;
    var haveEntry = data.length > 0 && withEntry / data.length >= 0.5;
    var dateOf = function (r) { return dateCol >= 0 ? parseDate(cellRaw(r, dateCol)) : null; };

    // was the list originally drawn oldest-first (a ledger) or newest-first?  → tie-break accordingly
    var byIdx = data.slice().sort(function (a, b) { return a._vtI - b._vtI; });
    var firstD = byIdx.length ? dateOf(byIdx[0]) : null, lastD = byIdx.length ? dateOf(byIdx[byIdx.length - 1]) : null;
    var origAsc = firstD != null && lastD != null && firstD < lastD;
    var idxTie = function (a, b) { return origAsc ? b._vtI - a._vtI : a._vtI - b._vtI; };

    var latest = function (a, b) {
      var c;
      if (ctx.statement && dateCol >= 0) { c = cmpNullLast(dateOf(a), dateOf(b), -1); if (c) return c; }
      if (haveEntry) { c = cmpNullLast(entryTime(a), entryTime(b), -1); if (c) return c; }
      if (!ctx.statement && dateCol >= 0) { c = cmpNullLast(dateOf(a), dateOf(b), -1); if (c) return c; }
      return idxTie(a, b);
    };

    var choice = ctx.select.value || 'latest', cmp;
    if (choice === 'latest') cmp = latest;
    else if (choice === 'oldest') cmp = function (a, b) { return latest(b, a); };
    else {
      var m = /^c(\d+):(asc|desc)$/.exec(choice);
      if (!m || !headers[+m[1]]) cmp = latest;
      else {
        var ci = +m[1], dir = m[2] === 'asc' ? 1 : -1, t = types[ci];
        var key = function (r) {
          var v = cellRaw(r, ci);
          if (v === '') return null;
          return t === 'date' ? parseDate(v) : t === 'num' ? parseNum(v) : v.toLowerCase();
        };
        cmp = function (a, b) {
          var ka = key(a), kb = key(b);
          if (ka != null && kb != null && t === 'text') {
            var c1 = ka.localeCompare(kb, undefined, { numeric: true, sensitivity: 'base' }) * dir;
            return c1 || latest(a, b);
          }
          var c = cmpNullLast(ka, kb, dir);
          return c || latest(a, b);
        };
      }
    }
    var sorted = data.slice().sort(cmp).concat(pinned);
    var same = sorted.length === rows.length && sorted.every(function (r, i) { return r === rows[i]; });
    if (same) return;
    ctx.obs.disconnect();
    sorted.forEach(function (r) { ctx.tbody.appendChild(r); });
    ctx.obs.observe(ctx.tbody, { childList: true });
  }

  function buildOptions(ctx, types, dateCol) {
    var keep = ctx.select.value || 'latest';
    var opts = [['latest', 'Latest first'], ['oldest', 'Oldest first']];
    if (dateCol >= 0) {
      var dn = ctx.headers[dateCol] || 'Date';
      opts.push(['c' + dateCol + ':desc', dn + ': newest first'], ['c' + dateCol + ':asc', dn + ': oldest first']);
    }
    ctx.headers.forEach(function (h, i) {
      if (!h || i === dateCol || types[i] === 'none') return;
      if (types[i] === 'num') opts.push(['c' + i + ':desc', h + ': high → low'], ['c' + i + ':asc', h + ': low → high']);
      else if (types[i] === 'date') opts.push(['c' + i + ':desc', h + ': newest first'], ['c' + i + ':asc', h + ': oldest first']);
      else opts.push(['c' + i + ':asc', h + ': A → Z'], ['c' + i + ':desc', h + ': Z → A']);
    });
    ctx.select.innerHTML = '';
    opts.forEach(function (o) {
      var el = document.createElement('option'); el.value = o[0]; el.textContent = o[1]; ctx.select.appendChild(el);
    });
    ctx.select.value = opts.some(function (o) { return o[0] === keep; }) ? keep : 'latest';
  }

  function enhance(tbody, statement) {
    if (!tbody || tbody._vtSort) return;
    var table = tbody.closest('table');
    if (!table || !table.tHead || !table.tHead.rows.length) return;
    var headers = Array.prototype.map.call(table.tHead.rows[0].cells, headerLabel);
    var bar = document.createElement('div');
    bar.className = 'vt-sortbar';
    bar.style.cssText = 'display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:12.5px;color:var(--muted,#6B6255);font-family:inherit';
    var label = document.createElement('label');
    label.style.cssText = 'display:inline-flex;align-items:center;gap:6px';
    label.appendChild(document.createTextNode('Sort by'));
    var select = document.createElement('select');
    select.className = 'vt-sortsel';
    select.setAttribute('aria-label', 'Sort this list');
    select.style.cssText = 'padding:5px 8px;border:1.5px solid var(--thread,#E9E1D3);border-radius:8px;background:#fff;font:inherit;font-size:12.5px;color:var(--ink,#1C1917);width:auto';
    label.appendChild(select);
    bar.appendChild(label);
    table.parentNode.insertBefore(bar, table);

    var ctx = { tbody: tbody, table: table, headers: headers, select: select, label: label, bar: bar, docked: false, seq: 0, sig: '', statement: !!statement, obs: null };
    setTimeout(function () { dock(ctx); }, 60); setTimeout(function () { dock(ctx); }, 500);   // the Excel bar is added a moment later
    ctx.obs = new MutationObserver(function () { apply(ctx); });
    select.addEventListener('change', function () { apply(ctx); });
    tbody._vtSort = ctx;
    ctxs.push(ctx);
    apply(ctx);
    ctx.obs.observe(tbody, { childList: true });
  }

  function scan() {
    LISTS.forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.tagName === 'TBODY') enhance(el, STATEMENTS.indexOf(id) >= 0);
    });
    Array.prototype.forEach.call(document.querySelectorAll('table[data-vt-sort]'), function (t) {
      if (t.tBodies[0]) enhance(t.tBodies[0], t.hasAttribute('data-vt-statement'));
    });
  }

  global.vtEnhanceTables = scan;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();
})(typeof window !== 'undefined' ? window : globalThis);
