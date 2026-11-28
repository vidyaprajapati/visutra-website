/* VISUTRA — purchase/payment statement as PDF → WhatsApp.
   window.vtStatement.offer({ ownerName, party:{name,phone,gstin}, purchases, payments, anchorId, side })
   shows a small card under the form with "Send statement on WhatsApp" / "Download PDF".
   Share order: Web Share (file) → AndroidBridge.shareFile (VISUTRA app) → download + wa.me chat link. */
(function(){
  'use strict';
  var JSPDF = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  var AUTOT = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js';
  function loadScript(src){
    return new Promise(function(res, rej){
      if(document.querySelector('script[src="' + src + '"]')) return res();
      var s = document.createElement('script'); s.src = src; s.onload = function(){ res(); }; s.onerror = function(){ rej(new Error('Could not load PDF library')); };
      document.head.appendChild(s);
    });
  }
  function ensurePdf(){
    if(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable) return Promise.resolve();
    return loadScript(JSPDF).then(function(){ return loadScript(AUTOT); });
  }
  function money(n){ return (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function phoneDigits(p){
    var d = String(p || '').replace(/\D/g, '');
    if(d.length === 10) d = '91' + d;
    if(d.length === 11 && d.charAt(0) === '0') d = '91' + d.slice(1);
    return d.length >= 11 ? d : '';
  }
  /* Merge purchases (debit) and payments (credit) into dated rows with a running balance. */
  function buildRows(purchases, payments){
    var rows = [];
    (purchases || []).forEach(function(p){
      var items = (p.items || []).map(function(li){ return (li.name || '') + ' × ' + (li.qty || 0); }).join(', ');
      rows.push({ date: p.date || '', kind: 'Purchase', desc: (p.invoiceNo ? 'Inv ' + p.invoiceNo + ' — ' : '') + items, debit: Number(p.grandTotal) || 0, credit: 0 });
    });
    (payments || []).forEach(function(p){
      rows.push({ date: p.date || '', kind: 'Payment', desc: (p.mode ? p.mode + ' ' : '') + (p.note || ''), debit: 0, credit: Number(p.amount) || 0 });
    });
    rows.sort(function(a, b){ return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    var bal = 0, dr = 0, cr = 0;
    rows.forEach(function(r){ bal += r.debit - r.credit; r.balance = bal; dr += r.debit; cr += r.credit; });
    return { rows: rows, totalPurchase: dr, totalPaid: cr, balance: bal };
  }
  function fileName(party){ return 'Statement-' + String(party.name || 'party').replace(/[^A-Za-z0-9]+/g, '_').slice(0, 30) + '-' + new Date().toISOString().slice(0, 10) + '.pdf'; }
  function makePdf(o){
    return ensurePdf().then(function(){
      var J = window.jspdf.jsPDF, doc = new J({ unit: 'pt', format: 'a4' }), s = buildRows(o.purchases, o.payments), party = o.party || {};
      doc.setFontSize(16); doc.text(o.ownerName || 'VISUTRA', 40, 44);
      doc.setFontSize(11); doc.setTextColor(90);
      doc.text('Statement of Purchases & Payments', 40, 62);
      doc.text((o.side === 'seller' ? 'Supplier: ' : 'Supplier: ') + (party.name || '') + (party.gstin ? '   GSTIN: ' + party.gstin : ''), 40, 78);
      function dmy(d){ var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ''); return m ? m[3] + '-' + m[2] + '-' + m[1] : (d || ''); }
      var first = s.rows.length ? dmy(s.rows[0].date) : '—';
      doc.text('Complete statement: ' + first + '  to  ' + new Date().toLocaleDateString('en-IN').replace(/\//g, '-') + ' (till date)', 40, 94);
      doc.setTextColor(0);
      doc.autoTable({
        startY: 108, theme: 'grid', styles: { fontSize: 8.5, cellPadding: 4 }, headStyles: { fillColor: [224, 83, 26] },
        head: [['Date', 'Type', 'Details', 'Purchase (Rs)', 'Paid (Rs)', 'Balance (Rs)']],
        body: s.rows.map(function(r){ return [r.date, r.kind, r.desc, r.debit ? money(r.debit) : '', r.credit ? money(r.credit) : '', money(r.balance)]; })
          .concat([['', '', 'TOTAL', money(s.totalPurchase), money(s.totalPaid), money(s.balance)]]),
        columnStyles: { 2: { cellWidth: 190 }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
        didParseCell: function(d){ if(d.row.index === s.rows.length) d.cell.styles.fontStyle = 'bold'; }
      });
      var y = doc.lastAutoTable.finalY + 18;
      if(y > 720){ doc.addPage(); y = 50; }
      doc.autoTable({
        startY: y, theme: 'grid', margin: { left: 300 }, tableWidth: 255, styles: { fontSize: 11, cellPadding: 6 },
        body: [['Total Purchase', 'Rs ' + money(s.totalPurchase)], ['Total Payment', 'Rs ' + money(s.totalPaid)], ['Balance to Pay', 'Rs ' + money(s.balance)]],
        columnStyles: { 0: { fontStyle: 'bold' }, 1: { halign: 'right', fontStyle: 'bold' } },
        didParseCell: function(d){ if(d.row.index === 2){ d.cell.styles.fillColor = [255, 237, 226]; d.cell.styles.textColor = s.balance > 0 ? [180, 35, 24] : [20, 120, 60]; } }
      });
      doc.setFontSize(8); doc.setTextColor(120); doc.text('Generated by VISUTRA (visutra.in)', 40, doc.lastAutoTable.finalY + 18);
      return { blob: doc.output('blob'), summary: s, name: fileName(party) };
    });
  }
  function blobToB64(blob){
    return new Promise(function(res, rej){ var r = new FileReader(); r.onload = function(){ res(String(r.result).split(',')[1]); }; r.onerror = rej; r.readAsDataURL(blob); });
  }
  function message(o, s){
    var party = o.party || {};
    return 'Dear ' + (party.name || 'Sir/Madam') + ',\nComplete statement (start till date) from ' + (o.ownerName || 'us') + ':\nTotal Purchase: ₹' + money(s.totalPurchase) + '\nTotal Payment: ₹' + money(s.totalPaid) + '\nBalance to Pay: ₹' + money(s.balance) + '\n(PDF attached)';
  }
  function download(blob, name){
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  async function share(o){
    var out = await makePdf(o), text = message(o, out.summary), party = o.party || {}, phone = phoneDigits(party.phone);
    var file = null; try{ file = new File([out.blob], out.name, { type: 'application/pdf' }); }catch(e){}
    if(file && navigator.canShare && navigator.canShare({ files: [file] })){
      try{ await navigator.share({ files: [file], text: text, title: out.name }); return 'shared'; }
      catch(e){ if(e && e.name === 'AbortError') return 'cancelled'; }
    }
    if(window.AndroidBridge && typeof window.AndroidBridge.shareFile === 'function'){
      window.AndroidBridge.shareFile(await blobToB64(out.blob), out.name, 'application/pdf', phone, text);
      return 'shared';
    }
    download(out.blob, out.name);
    window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(text + '\n\nThe PDF is saved in your Downloads — please attach it in this chat.'), '_blank');
    return 'fallback';
  }
  /* Generic: share any PDF blob (order sheets etc.) — same three routes as share(). */
  async function sharePdf(o){
    var phone = phoneDigits(o.phone), file = null;
    try{ file = new File([o.blob], o.name, { type: 'application/pdf' }); }catch(e){}
    if(file && navigator.canShare && navigator.canShare({ files: [file] })){
      try{ await navigator.share({ files: [file], text: o.text, title: o.name }); return 'shared'; }
      catch(e){ if(e && e.name === 'AbortError') return 'cancelled'; }
    }
    if(window.AndroidBridge && typeof window.AndroidBridge.shareFile === 'function'){
      window.AndroidBridge.shareFile(await blobToB64(o.blob), o.name, 'application/pdf', phone, o.text || '');
      return 'shared';
    }
    download(o.blob, o.name);
    window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent((o.text || '') + '\n\nThe PDF is saved in your Downloads — please attach it in this chat.'), '_blank');
    return 'fallback';
  }
  function offer(o){
    var anchor = document.getElementById(o.anchorId || 'purchaseMsg'); if(!anchor) return;
    var box = document.getElementById('vtStmtBox');
    if(!box){ box = document.createElement('div'); box.id = 'vtStmtBox'; anchor.parentNode.insertBefore(box, anchor.nextSibling); }
    box.style.cssText = 'margin:10px 0;padding:12px 14px;border:1px solid #cfe9d6;background:#f0faf3;border-radius:14px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:#1c1917;font-size:14px';
    var party = o.party || {}, s = buildRows(o.purchases, o.payments);
    box.innerHTML = '<span style="flex:1 1 220px">📄 Statement for <b>' + esc(party.name) + '</b> — balance ₹' + money(s.balance) + (party.phone ? '' : '<br><small style="color:#b54708">No phone saved for this supplier — you will pick the chat in WhatsApp.</small>') + '</span>'
      + '<button type="button" id="vtStmtWa" class="btn small" style="background:#25D366;color:#fff;border:0;border-radius:12px;padding:10px 14px;font-weight:700">Send on WhatsApp</button>'
      + '<button type="button" id="vtStmtDl" class="btn small">Download PDF</button>'
      + '<button type="button" id="vtStmtX" aria-label="Close" style="border:0;background:transparent;font-size:20px;cursor:pointer">×</button>';
    var busy = false;
    document.getElementById('vtStmtWa').onclick = async function(){
      if(busy) return; busy = true; this.textContent = 'Preparing…';
      try{ await share(o); }catch(e){ alert('Could not create the statement: ' + e.message); }
      busy = false; this.textContent = 'Send on WhatsApp';
    };
    document.getElementById('vtStmtDl').onclick = async function(){
      try{ var out = await makePdf(o); download(out.blob, out.name); }catch(e){ alert('Could not create the PDF: ' + e.message); }
    };
    document.getElementById('vtStmtX').onclick = function(){ box.remove(); };
  }
  window.vtStatement = { sharePdf: sharePdf, ensurePdf: ensurePdf, download: download, offer: offer, buildRows: buildRows, phoneDigits: phoneDigits, share: share, makePdf: makePdf, message: message };
})();
