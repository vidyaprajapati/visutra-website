let currentUser = null;
let businessData = {};
let productsCache = [];
let customersCache = [];
let lineItems = []; // {productId, name, hsn, unit, qty, rate, discount, gstRate}

/* ---------------- Auth guard ---------------- */
auth.onAuthStateChanged(async user => {
  const verified = user && (user.emailVerified || user.providerData.some(p => p.providerId === 'google.com'));
  if(!verified){ window.location.href = 'login.html'; return; }

  const snap = await db.collection('users').doc(user.uid).get();
  if(!snap.exists || !snap.data().profileComplete){
    window.location.href = 'complete-profile.html?redirect=' + encodeURIComponent('app.html');
    return;
  }

  currentUser = user;
  mountUserMenu('userMenuMount', user, { showBillingLink: false });
  populateStateSelect(document.getElementById('bizState'));
  populateStateSelect(document.getElementById('cState'));
  document.getElementById('invDate').valueAsDate = new Date();
  populateGstrFY();
  onFilingTypeChange();
  initSignaturePad();
  await loadProfile();
  populateUnitSelect();
  populateHsnDatalist();
  await loadProducts();
  await loadCustomers();
  addLineItem();
  loadInvoices();
});

function signOut(){ auth.signOut().then(()=> window.location.href = 'login.html'); }

/* ---------------- Nav ---------------- */
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    link.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById('view-' + link.dataset.view).classList.remove('hidden');
    if(link.dataset.view === 'invoices') loadInvoices();
  });
});

/* ---------------- Business profile ---------------- */
async function loadProfile(){
  const snap = await db.collection('users').doc(currentUser.uid).get();
  businessData = snap.data() || {};
  document.getElementById('bizName').value = businessData.businessName || '';
  document.getElementById('bizGstin').value = businessData.gstin || '';
  document.getElementById('bizAddress').value = businessData.address || '';
  document.getElementById('bizState').value = businessData.stateCode || '';
  document.getElementById('bizPhone').value = businessData.phone || '';
  if(businessData.signature){
    document.getElementById('sigPreview').src = businessData.signature;
    document.getElementById('sigPreviewWrap').classList.remove('hidden');
  }
}

async function saveProfile(){
  const stateCode = document.getElementById('bizState').value;
  const data = {
    businessName: document.getElementById('bizName').value.trim(),
    gstin: document.getElementById('bizGstin').value.trim(),
    address: document.getElementById('bizAddress').value.trim(),
    stateCode: stateCode,
    state: stateNameByCode(stateCode),
    phone: document.getElementById('bizPhone').value.trim()
  };
  await db.collection('users').doc(currentUser.uid).set(data, {merge:true});
  Object.assign(businessData, data);
  showMsg('profileMsg', 'Saved.', true);
}

/* ---------------- Signature pad ---------------- */
let sigCtx, drawing = false;
function initSignaturePad(){
  const canvas = document.getElementById('sigPad');
  sigCtx = canvas.getContext('2d');
  sigCtx.lineWidth = 2; sigCtx.lineCap = 'round'; sigCtx.strokeStyle = '#1F1B16';
  const pos = e => {
    const r = canvas.getBoundingClientRect();
    const p = e.touches ? e.touches[0] : e;
    return { x: p.clientX - r.left, y: p.clientY - r.top };
  };
  const start = e => { drawing = true; const p = pos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = e => { if(!drawing) return; const p = pos(e); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); e.preventDefault(); };
  const end = () => drawing = false;
  canvas.addEventListener('mousedown', start); canvas.addEventListener('mousemove', move);
  window.addEventListener('mouseup', end);
  canvas.addEventListener('touchstart', start); canvas.addEventListener('touchmove', move);
  canvas.addEventListener('touchend', end);
}
function clearSignature(){ sigCtx.clearRect(0,0,400,150); }
async function saveSignature(){
  const dataUrl = document.getElementById('sigPad').toDataURL('image/png');
  await db.collection('users').doc(currentUser.uid).set({signature: dataUrl}, {merge:true});
  businessData.signature = dataUrl;
  document.getElementById('sigPreview').src = dataUrl;
  document.getElementById('sigPreviewWrap').classList.remove('hidden');
  showMsg('sigMsg', 'Signature saved.', true);
}

/* ---------------- Products ---------------- */

// Standard GST UQC (Unit Quantity Code) list, used across GSTR filings.
const UQC_UNITS = [
  {code:'PCS', label:'PCS — Pieces'}, {code:'NOS', label:'NOS — Numbers'},
  {code:'SET', label:'SET — Sets'}, {code:'PRS', label:'PRS — Pairs'},
  {code:'KGS', label:'KGS — Kilograms'}, {code:'GMS', label:'GMS — Grammes'},
  {code:'MTR', label:'MTR — Metres'}, {code:'CMS', label:'CMS — Centimetres'},
  {code:'SQM', label:'SQM — Square Metres'}, {code:'SQF', label:'SQF — Square Feet'},
  {code:'SQY', label:'SQY — Square Yards'}, {code:'YDS', label:'YDS — Yards'},
  {code:'LTR', label:'LTR — Litres'}, {code:'MLT', label:'MLT — Millilitres'},
  {code:'KLR', label:'KLR — Kilolitres'}, {code:'BOX', label:'BOX — Box'},
  {code:'CTN', label:'CTN — Cartons'}, {code:'PAC', label:'PAC — Packs'},
  {code:'BAG', label:'BAG — Bags'}, {code:'BDL', label:'BDL — Bundles'},
  {code:'BTL', label:'BTL — Bottles'}, {code:'CAN', label:'CAN — Cans'},
  {code:'DOZ', label:'DOZ — Dozens'}, {code:'DRM', label:'DRM — Drums'},
  {code:'GRS', label:'GRS — Gross'}, {code:'ROL', label:'ROL — Rolls'},
  {code:'TON', label:'TON — Tonnes'}, {code:'QTL', label:'QTL — Quintal'},
  {code:'TUB', label:'TUB — Tubes'}, {code:'UNT', label:'UNT — Units'},
  {code:'OTH', label:'OTH — Others'}
];

function populateUnitSelect(){
  const sel = document.getElementById('pUnit');
  sel.innerHTML = UQC_UNITS.map(u => `<option value="${u.code}">${u.label}</option>`).join('');
  sel.value = (businessData.lastUsedUnit) || 'PCS';
}

function populateHsnDatalist(){
  document.getElementById('hsnList').innerHTML = HSN_GST_REFERENCE
    .map(h => `<option value="${h.hsn}">${esc(h.desc)}</option>`).join('');
}

function onHsnInput(){
  const val = document.getElementById('pHsn').value.trim();
  const match = HSN_GST_REFERENCE.find(h => h.hsn === val);
  const note = document.getElementById('pHsnNote');
  if(!match){ note.textContent = ''; note.className = 'msg'; return; }
  if(match.rate == null){
    note.textContent = match.note || 'This HSN has a variable rate — check the official rate schedule.';
    note.className = 'msg error';
  } else {
    note.textContent = `${esc(match.desc)} — commonly ${match.rate}% GST (verify and select the rate yourself below).`;
    note.className = 'msg ok';
  }
}

// Two-way price calculation: entering either the GST-inclusive final price
// or the excl.-GST base price fills in the other, using the selected rate.
let lastProductPriceEdited = 'excl';
function onProductPriceOrRateChange(source){
  if(source !== 'rate') lastProductPriceEdited = source;
  const rate = parseFloat(document.getElementById('pGst').value) || 0;
  const inclEl = document.getElementById('pPriceIncl');
  const exclEl = document.getElementById('pPrice');
  if(lastProductPriceEdited === 'incl'){
    const incl = parseFloat(inclEl.value);
    if(!isNaN(incl)) exclEl.value = (incl / (1 + rate/100)).toFixed(2);
  } else {
    const excl = parseFloat(exclEl.value);
    if(!isNaN(excl)) inclEl.value = (excl * (1 + rate/100)).toFixed(2);
  }
}

async function loadProducts(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('products').orderBy('name').get();
  productsCache = snap.docs.map(d => ({id:d.id, ...d.data()}));
  renderProducts();
  renderProductDropdowns();
}
function renderProducts(){
  document.getElementById('productsTable').innerHTML = productsCache.map(p => `
    <tr><td>${esc(p.name)}</td><td>${esc(p.hsn)}</td><td>${esc(p.unit)}</td><td>₹${p.price}</td><td>${p.gstRate}%</td>
    <td class="row-actions">
      <button class="btn small" onclick="editProduct('${p.id}')">Edit</button>
      <button class="btn small danger" onclick="deleteProduct('${p.id}')">Delete</button>
    </td></tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">No products yet.</td></tr>';
}
async function saveProduct(){
  const id = document.getElementById('pEditId').value;
  const unit = document.getElementById('pUnit').value || 'PCS';
  const data = {
    name: document.getElementById('pName').value.trim(),
    hsn: document.getElementById('pHsn').value.trim(),
    unit,
    price: parseFloat(document.getElementById('pPrice').value) || 0,
    gstRate: parseFloat(document.getElementById('pGst').value)
  };
  if(!data.name){ showMsg('productMsg', 'Product name is required.', false); return; }
  const col = db.collection('users').doc(currentUser.uid).collection('products');
  if(id){ await col.doc(id).set(data); } else { await col.add(data); }

  // Remember the unit just used as the default for next time.
  businessData.lastUsedUnit = unit;
  await db.collection('users').doc(currentUser.uid).set({lastUsedUnit: unit}, {merge:true});

  ['pName','pHsn','pPrice','pPriceIncl','pEditId'].forEach(f => document.getElementById(f).value = '');
  document.getElementById('pGst').value = '0';
  document.getElementById('pHsnNote').textContent = '';
  populateUnitSelect();
  lastProductPriceEdited = 'excl';
  showMsg('productMsg', 'Saved.', true);
  loadProducts();
}
function editProduct(id){
  const p = productsCache.find(x => x.id === id);
  document.getElementById('pEditId').value = id;
  document.getElementById('pName').value = p.name;
  document.getElementById('pHsn').value = p.hsn;
  document.getElementById('pUnit').value = p.unit;
  document.getElementById('pPrice').value = p.price;
  document.getElementById('pGst').value = p.gstRate;
  lastProductPriceEdited = 'excl';
  onProductPriceOrRateChange('excl');
  onHsnInput();
}
async function deleteProduct(id){
  if(!confirm('Delete this product?')) return;
  await db.collection('users').doc(currentUser.uid).collection('products').doc(id).delete();
  loadProducts();
}

/* ---------------- Customers ---------------- */
async function loadCustomers(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('customers').orderBy('name').get();
  customersCache = snap.docs.map(d => ({id:d.id, ...d.data()}));
  renderCustomers();
  renderCustomerDropdown();
}
function renderCustomers(){
  document.getElementById('customersTable').innerHTML = customersCache.map(c => `
    <tr><td>${esc(c.name)}</td><td>${esc(c.gstin||'—')}</td><td>${esc(c.state||'')}</td><td>${esc(c.email||'')}</td>
    <td class="row-actions">
      <button class="btn small" onclick="editCustomer('${c.id}')">Edit</button>
      <button class="btn small danger" onclick="deleteCustomer('${c.id}')">Delete</button>
    </td></tr>`).join('') || '<tr><td colspan="5" style="color:var(--muted)">No customers yet.</td></tr>';
}
async function saveCustomer(){
  const id = document.getElementById('cEditId').value;
  const stateCode = document.getElementById('cState').value;
  const data = {
    name: document.getElementById('cName').value.trim(),
    gstin: document.getElementById('cGstin').value.trim(),
    address: document.getElementById('cAddress').value.trim(),
    stateCode: stateCode,
    state: stateNameByCode(stateCode),
    email: document.getElementById('cEmail').value.trim(),
    phone: document.getElementById('cPhone').value.trim()
  };
  if(!data.name){ showMsg('customerMsg', 'Customer name is required.', false); return; }
  const col = db.collection('users').doc(currentUser.uid).collection('customers');
  if(id){ await col.doc(id).set(data); } else { await col.add(data); }
  ['cName','cGstin','cAddress','cEmail','cPhone','cEditId'].forEach(f => document.getElementById(f).value = '');
  document.getElementById('cState').value = '';
  showMsg('customerMsg', 'Saved.', true);
  loadCustomers();
}
function editCustomer(id){
  const c = customersCache.find(x => x.id === id);
  document.getElementById('cEditId').value = id;
  document.getElementById('cName').value = c.name;
  document.getElementById('cGstin').value = c.gstin || '';
  document.getElementById('cAddress').value = c.address || '';
  document.getElementById('cState').value = c.stateCode || '';
  document.getElementById('cEmail').value = c.email || '';
  document.getElementById('cPhone').value = c.phone || '';
}
async function deleteCustomer(id){
  if(!confirm('Delete this customer?')) return;
  await db.collection('users').doc(currentUser.uid).collection('customers').doc(id).delete();
  loadCustomers();
}
function renderCustomerDropdown(){
  const sel = document.getElementById('invCustomer');
  sel.innerHTML = '<option value="">Select customer…</option>' +
    customersCache.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

/* ---------------- Invoice line items ---------------- */
function renderProductDropdowns(){
  document.querySelectorAll('.line-product').forEach(sel => fillProductOptions(sel));
}
function fillProductOptions(sel){
  sel.innerHTML = '<option value="">Select product…</option>' +
    productsCache.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
}
function addLineItem(){
  const idx = lineItems.length;
  lineItems.push({productId:'', name:'', hsn:'', unit:'PCS', qty:1, rate:0, discount:0, gstRate:0});
  renderLineItems();
}
function removeLineItem(idx){
  lineItems.splice(idx, 1);
  renderLineItems();
}
function renderLineItems(){
  const tbody = document.getElementById('lineItemsTable');
  tbody.innerHTML = lineItems.map((li, i) => `
    <tr>
      <td><select class="line-product" onchange="onProductPick(${i}, this.value)">${''}</select></td>
      <td><input type="number" min="0" step="1" value="${li.qty}" style="width:60px" onchange="updateLine(${i},'qty',this.value)"></td>
      <td>${esc(li.unit)}</td>
      <td><input type="number" min="0" step="0.01" value="${li.rate}" style="width:80px" onchange="updateLine(${i},'rate',this.value)"></td>
      <td><input type="number" min="0" max="100" step="0.01" value="${li.discount}" style="width:60px" onchange="updateLine(${i},'discount',this.value)"></td>
      <td>${fmtMoney(lineTaxable(li))}</td>
      <td>${li.gstRate}%</td>
      <td><button class="btn small danger" onclick="removeLineItem(${i})">✕</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('.line-product').forEach((sel, i) => {
    fillProductOptions(sel);
    sel.value = lineItems[i].productId;
  });
  recalcTotals();
}
function onProductPick(idx, productId){
  const p = productsCache.find(x => x.id === productId);
  if(!p) return;
  lineItems[idx] = { productId, name:p.name, hsn:p.hsn, unit:p.unit, qty:lineItems[idx].qty||1, rate:p.price, discount:0, gstRate:p.gstRate };
  renderLineItems();
}
function updateLine(idx, field, value){
  lineItems[idx][field] = parseFloat(value) || 0;
  renderLineItems();
}
function lineTaxable(li){
  const gross = (li.qty||0) * (li.rate||0);
  const disc = gross * ((li.discount||0)/100);
  return Math.max(gross - disc, 0);
}
function recalcTotals(){
  const custId = document.getElementById('invCustomer').value;
  const customer = customersCache.find(c => c.id === custId);
  const sameState = customer && customer.stateCode && businessData.stateCode && customer.stateCode === businessData.stateCode;

  let subtotal = 0, cgst = 0, sgst = 0, igst = 0;
  lineItems.forEach(li => {
    const taxable = lineTaxable(li);
    subtotal += taxable;
    const taxAmt = taxable * (li.gstRate||0) / 100;
    if(sameState){ cgst += taxAmt/2; sgst += taxAmt/2; } else { igst += taxAmt; }
  });
  const grand = subtotal + cgst + sgst + igst;

  const box = document.getElementById('totalsBox');
  const rows = [];
  rows.push(`<div class="totals-row"><span>Taxable value</span><span>${fmtMoney(subtotal)}</span></div>`);
  if(sameState || (!customer)){
    rows.push(`<div class="totals-row"><span>CGST</span><span>${fmtMoney(cgst)}</span></div>`);
    rows.push(`<div class="totals-row"><span>SGST</span><span>${fmtMoney(sgst)}</span></div>`);
  } else {
    rows.push(`<div class="totals-row"><span>IGST</span><span>${fmtMoney(igst)}</span></div>`);
  }
  rows.push(`<div class="totals-row grand"><span>Grand total</span><span>${fmtMoney(grand)}</span></div>`);
  box.innerHTML = rows.join('');

  return {subtotal, cgst, sgst, igst, grand, sameState: !!sameState};
}

/* ---------------- Invoice numbering (financial year based) ---------------- */
function currentFY(date){
  const d = date || new Date();
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? y : y - 1; // FY starts April (month index 3)
  return `${String(startYear).slice(2)}-${String(startYear+1).slice(2)}`;
}
async function nextInvoiceNumber(date){
  const fy = currentFY(date);
  const counterRef = db.collection('users').doc(currentUser.uid).collection('meta').doc('invoiceCounter');
  return db.runTransaction(async tx => {
    const snap = await tx.get(counterRef);
    let data = snap.exists ? snap.data() : {fy:'', lastNumber:0};
    if(data.fy !== fy){ data = {fy, lastNumber:0}; }
    data.lastNumber += 1;
    tx.set(counterRef, data);
    return `${fy}/${String(data.lastNumber).padStart(4,'0')}`;
  });
}

/* ---------------- Save, PDF, email ---------------- */
async function saveAndGenerate(sendEmail){
  const custId = document.getElementById('invCustomer').value;
  const customer = customersCache.find(c => c.id === custId);
  if(!customer){ showMsg('invoiceMsg', 'Select a customer first.', false); return; }
  if(!businessData.businessName || !businessData.gstin){ showMsg('invoiceMsg', 'Complete your Business Profile first.', false); return; }
  if(!lineItems.length || lineItems.every(li => !li.productId)){ showMsg('invoiceMsg', 'Add at least one line item.', false); return; }
  if(sendEmail && !customer.email){ showMsg('invoiceMsg', 'This customer has no email address saved — add one in Customers.', false); return; }

  showMsg('invoiceMsg', 'Saving invoice…', true);
  const dateVal = document.getElementById('invDate').value || new Date().toISOString().slice(0,10);
  const invoiceDate = new Date(dateVal);
  const invoiceNo = await nextInvoiceNumber(invoiceDate);
  const totals = recalcTotals();
  const reverseCharge = document.getElementById('invReverseCharge').checked;

  const invoiceData = {
    invoiceNo, date: dateVal, reverseCharge,
    business: { ...businessData },
    customer: { name:customer.name, gstin:customer.gstin, address:customer.address, state:customer.state, stateCode:customer.stateCode, email:customer.email },
    items: lineItems.map(li => ({...li, taxable: lineTaxable(li)})),
    subtotal: totals.subtotal, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, grandTotal: totals.grand,
    sameState: totals.sameState,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    emailSent: false
  };

  const ref = await db.collection('users').doc(currentUser.uid).collection('invoices').add(invoiceData);

  showMsg('invoiceMsg', 'Generating PDF…', true);
  const pdfBlob = buildInvoicePDF(invoiceData);

  // Public-readable copy for the "view online" link (no login required for the buyer).
  // The PDF itself is never uploaded anywhere — it's regenerated on demand from this
  // same saved data, both here and on the public invoice-view page, so no Firebase
  // Storage (and no paid Blaze plan) is needed at all.
  await db.collection('public_invoices').doc(ref.id).set(invoiceData);

  // Trigger local download for the business owner.
  downloadBlob(pdfBlob, `Invoice-${invoiceNo.replace('/','-')}.pdf`);

  if(sendEmail){
    showMsg('invoiceMsg', 'Sending email…', true);
    try{
      await sendInvoiceEmail(invoiceData, ref.id);
      await ref.set({emailSent:true}, {merge:true});
      showMsg('invoiceMsg', 'Invoice saved, downloaded, and emailed to ' + customer.email + '.', true);
    }catch(err){
      showMsg('invoiceMsg', 'Invoice saved and downloaded, but the email failed to send: ' + err.text || err.message, false);
    }
  } else {
    showMsg('invoiceMsg', 'Invoice saved and downloaded.', true);
  }

  lineItems = [];
  addLineItem();
  loadInvoices();
}

function buildInvoicePDF(inv){
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({unit:'pt', format:'a4'});
  const pageW = doc.internal.pageSize.getWidth();
  let y = 40;

  doc.setFont('helvetica','bold'); doc.setFontSize(16);
  doc.text('TAX INVOICE', pageW/2, y, {align:'center'});
  y += 14;
  doc.setFontSize(9); doc.setFont('helvetica','normal');
  doc.text('Original for Recipient', pageW/2, y, {align:'center'});
  y += 24;

  doc.setFont('helvetica','bold'); doc.setFontSize(11);
  doc.text(inv.business.businessName || '', 40, y);
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
  y += 14;
  const bizAddrLines = doc.splitTextToSize(inv.business.address || '', 250);
  doc.text(bizAddrLines, 40, y); y += bizAddrLines.length * 12;
  doc.text(`GSTIN: ${inv.business.gstin || ''}`, 40, y); y += 12;
  doc.text(`State: ${inv.business.state || ''} (${inv.business.stateCode || ''})`, 40, y);

  let yR = 78;
  doc.setFont('helvetica','bold'); doc.text('Invoice No:', 330, yR); doc.setFont('helvetica','normal'); doc.text(inv.invoiceNo, 410, yR); yR += 14;
  doc.setFont('helvetica','bold'); doc.text('Invoice Date:', 330, yR); doc.setFont('helvetica','normal'); doc.text(inv.date, 410, yR); yR += 14;
  doc.setFont('helvetica','bold'); doc.text('Reverse charge:', 330, yR); doc.setFont('helvetica','normal'); doc.text(inv.reverseCharge ? 'Yes' : 'No', 410, yR); yR += 14;
  doc.setFont('helvetica','bold'); doc.text('Place of supply:', 330, yR); doc.setFont('helvetica','normal');
  doc.text(`${inv.customer.state || ''} (${inv.customer.stateCode || ''})`, 410, yR);

  y = Math.max(y, yR) + 26;
  doc.setDrawColor(200); doc.line(40, y, pageW-40, y); y += 18;

  doc.setFont('helvetica','bold'); doc.setFontSize(10); doc.text('Bill To:', 40, y); y += 14;
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
  doc.text(inv.customer.name || '', 40, y); y += 12;
  const custAddrLines = doc.splitTextToSize(inv.customer.address || '', 300);
  doc.text(custAddrLines, 40, y); y += custAddrLines.length * 12;
  if(inv.customer.gstin){ doc.text(`GSTIN: ${inv.customer.gstin}`, 40, y); y += 12; }
  doc.text(`State: ${inv.customer.state || ''}`, 40, y);
  y += 22;

  const sameState = inv.sameState;
  const head = sameState
    ? [['#','Description','HSN','Qty','Unit','Rate','Taxable','CGST','SGST','Total']]
    : [['#','Description','HSN','Qty','Unit','Rate','Taxable','IGST','Total']];

  const body = inv.items.filter(li => li.productId).map((li, i) => {
    const taxable = li.taxable;
    const taxAmt = taxable * (li.gstRate||0) / 100;
    if(sameState){
      const half = taxAmt/2;
      return [i+1, li.name, li.hsn, li.qty, li.unit, fmtMoney(li.rate), fmtMoney(taxable), fmtMoney(half), fmtMoney(half), fmtMoney(taxable+taxAmt)];
    } else {
      return [i+1, li.name, li.hsn, li.qty, li.unit, fmtMoney(li.rate), fmtMoney(taxable), fmtMoney(taxAmt), fmtMoney(taxable+taxAmt)];
    }
  });

  doc.autoTable({ head, body, startY: y, styles:{fontSize:8.5, cellPadding:4}, headStyles:{fillColor:[46,67,116]}, margin:{left:40,right:40} });
  y = doc.lastAutoTable.finalY + 20;

  const totalsX = pageW - 220;
  doc.setFontSize(9.5);
  doc.text('Taxable Value:', totalsX, y); doc.text(fmtMoney(inv.subtotal), pageW-40, y, {align:'right'}); y += 14;
  if(sameState){
    doc.text('CGST:', totalsX, y); doc.text(fmtMoney(inv.cgst), pageW-40, y, {align:'right'}); y += 14;
    doc.text('SGST:', totalsX, y); doc.text(fmtMoney(inv.sgst), pageW-40, y, {align:'right'}); y += 14;
  } else {
    doc.text('IGST:', totalsX, y); doc.text(fmtMoney(inv.igst), pageW-40, y, {align:'right'}); y += 14;
  }
  doc.setFont('helvetica','bold'); doc.setFontSize(11);
  doc.text('Grand Total:', totalsX, y); doc.text('Rs. ' + fmtMoney(inv.grandTotal), pageW-40, y, {align:'right'});
  y += 34;

  doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
  doc.text('Tax is payable on reverse charge basis: ' + (inv.reverseCharge ? 'Yes' : 'No'), 40, y);
  doc.text('This is a computer-generated invoice.', 40, y+12);

  // Signature block, bottom right
  const sigY = y - 10;
  doc.setFontSize(9);
  doc.text(`For ${inv.business.businessName || ''}`, pageW-160, sigY, {align:'center'});
  if(inv.business.signature){
    try{ doc.addImage(inv.business.signature, 'PNG', pageW-210, sigY+8, 100, 40); }catch(e){}
  }
  doc.text('Authorized Signatory', pageW-160, sigY+56, {align:'center'});

  return doc.output('blob');
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function sendInvoiceEmail(inv, invoiceId){
  emailjs.init(EMAILJS_PUBLIC_KEY);
  const viewLink = `${window.location.origin}/billing/invoice-view.html?id=${invoiceId}`;
  return emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
    to_email: inv.customer.email,
    to_name: inv.customer.name,
    invoice_no: inv.invoiceNo,
    invoice_date: inv.date,
    business_name: inv.business.businessName,
    grand_total: fmtMoney(inv.grandTotal),
    view_link: viewLink
  });
}

/* ---------------- Invoice history ---------------- */
let invoicesCache = {};
async function loadInvoices(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('invoices').orderBy('createdAt','desc').limit(100).get();
  invoicesCache = {};
  const rows = snap.docs.map(d => {
    invoicesCache[d.id] = d.data();
    const inv = d.data();
    return `<tr>
      <td>${esc(inv.invoiceNo||'')}</td><td>${esc(inv.date||'')}</td><td>${esc(inv.customer?.name||'')}</td>
      <td>₹${fmtMoney(inv.grandTotal||0)}</td>
      <td><span class="badge">${inv.emailSent ? 'Sent' : 'Not sent'}</span></td>
      <td class="row-actions">
        <button class="btn small" onclick="redownloadInvoicePdf('${d.id}')">Download PDF</button>
        <a class="btn small" href="invoice-view.html?id=${d.id}" target="_blank">View</a>
      </td>
    </tr>`;
  }).join('');
  document.getElementById('invoicesTable').innerHTML = rows || '<tr><td colspan="6" style="color:var(--muted)">No invoices yet.</td></tr>';
}

// PDFs are never stored as files anywhere — every download is generated fresh,
// on the spot, from the saved invoice data. This avoids needing Firebase
// Storage (which now requires the paid Blaze plan even for free-tier usage).
function redownloadInvoicePdf(invoiceId){
  const inv = invoicesCache[invoiceId];
  if(!inv) return;
  const blob = buildInvoicePDF(inv);
  downloadBlob(blob, `Invoice-${(inv.invoiceNo||invoiceId).replace('/','-')}.pdf`);
}

/* ---------------- GSTR-1 report (built from saved invoices — no re-entry needed) ---------------- */
let gstr1Data = null;
const B2CL_THRESHOLD = 100000; // current GST rule, effective Aug 2024 (was ₹2.5L before)

function poS(cust){
  if(!cust) return '';
  return cust.stateCode ? `${cust.stateCode}-${cust.state||''}` : (cust.state||'');
}
function fix2(n){ return Math.round((n||0)*100)/100; }

/* ---------------- Return period selector (FY + Monthly/Quarterly) ---------------- */
const FY_MONTHS = [
  {m:4,label:'April'}, {m:5,label:'May'}, {m:6,label:'June'},
  {m:7,label:'July'}, {m:8,label:'August'}, {m:9,label:'September'},
  {m:10,label:'October'}, {m:11,label:'November'}, {m:12,label:'December'},
  {m:1,label:'January'}, {m:2,label:'February'}, {m:3,label:'March'}
];
const FY_QUARTERS = [
  {q:1, label:'Q1 (Apr – Jun)', months:[4,5,6]},
  {q:2, label:'Q2 (Jul – Sep)', months:[7,8,9]},
  {q:3, label:'Q3 (Oct – Dec)', months:[10,11,12]},
  {q:4, label:'Q4 (Jan – Mar)', months:[1,2,3]}
];

function currentFYStartYear(d){
  d = d || new Date();
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
}

function populateGstrFY(){
  const sel = document.getElementById('gstrFY');
  const curStart = currentFYStartYear();
  const years = [curStart - 2, curStart - 1, curStart]; // last 3 financial years
  sel.innerHTML = years.map(y => `<option value="${y}">FY ${y}-${String(y+1).slice(2)}</option>`).join('');
  sel.value = curStart;
  onFYChange();
}

function onFYChange(){
  populateGstrMonth();
  populateGstrQuarter();
}

function populateGstrMonth(){
  const fyStart = parseInt(document.getElementById('gstrFY').value, 10);
  const sel = document.getElementById('gstrMonth');
  sel.innerHTML = FY_MONTHS.map(x => {
    const year = x.m >= 4 ? fyStart : fyStart + 1;
    return `<option value="${year}-${String(x.m).padStart(2,'0')}">${x.label} ${year}</option>`;
  }).join('');
  const now = new Date();
  const nowVal = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  if([...sel.options].some(o => o.value === nowVal)) sel.value = nowVal;
}

function populateGstrQuarter(){
  const fyStart = parseInt(document.getElementById('gstrFY').value, 10);
  const sel = document.getElementById('gstrQuarter');
  sel.innerHTML = FY_QUARTERS.map(q => {
    const startYear = q.months[0] >= 4 ? fyStart : fyStart + 1;
    const endYear = q.months[2] >= 4 ? fyStart : fyStart + 1;
    return `<option value="${q.q}">${q.label} ${startYear}${endYear!==startYear ? '-'+String(endYear).slice(2) : ''}</option>`;
  }).join('');
  const now = new Date();
  if(currentFYStartYear(now) === fyStart){
    const curMonth = now.getMonth() + 1;
    const match = FY_QUARTERS.find(x => x.months.includes(curMonth));
    if(match) sel.value = match.q;
  }
}

function onFilingTypeChange(){
  const type = document.getElementById('gstrType').value;
  document.getElementById('gstrMonthWrap').classList.toggle('hidden', type !== 'monthly');
  document.getElementById('gstrQuarterWrap').classList.toggle('hidden', type !== 'quarterly');
}

// Resolves the current picker state into a concrete date range + display label,
// used by the GSTR-1 report generator below.
function getSelectedPeriodRange(){
  const type = document.getElementById('gstrType').value;
  if(type === 'monthly'){
    const val = document.getElementById('gstrMonth').value; // "YYYY-MM"
    const [y, m] = val.split('-').map(Number);
    return { start: new Date(y, m-1, 1), end: new Date(y, m, 1), label: val, fileTag: val };
  }
  const fyStart = parseInt(document.getElementById('gstrFY').value, 10);
  const qNum = parseInt(document.getElementById('gstrQuarter').value, 10);
  const q = FY_QUARTERS.find(x => x.q === qNum);
  const startMonth = q.months[0];
  const startYear = startMonth >= 4 ? fyStart : fyStart + 1;
  const start = new Date(startYear, startMonth - 1, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 3, 1);
  const label = `Q${qNum} FY${fyStart}-${String(fyStart+1).slice(2)}`;
  return { start, end, label, fileTag: `Q${qNum}-FY${fyStart}-${String(fyStart+1).slice(2)}` };
}

async function generateGstr1(){
  const period = getSelectedPeriodRange();
  showMsg('gstrMsg', 'Reading invoices for this period…', true);

  const start = period.start, end = period.end;

  const snap = await db.collection('users').doc(currentUser.uid).collection('invoices').get();
  const invoices = snap.docs.map(d => d.data()).filter(inv => {
    const d = new Date(inv.date);
    return d >= start && d < end;
  });

  const b2b = [], b2cl = [], b2csMap = {}, hsnMap = {};

  invoices.forEach(inv => {
    const isRegistered = !!(inv.customer && inv.customer.gstin);
    const interState = !inv.sameState;
    const items = (inv.items || []).filter(li => li.productId);

    if(isRegistered){
      const rateGroups = {};
      items.forEach(li => { rateGroups[li.gstRate] = (rateGroups[li.gstRate]||0) + li.taxable; });
      Object.keys(rateGroups).forEach(rate => {
        b2b.push([
          inv.customer.gstin, inv.customer.name, inv.invoiceNo, inv.date,
          fix2(inv.grandTotal), poS(inv.customer), inv.reverseCharge ? 'Y' : 'N',
          '', 'Regular', Number(rate), fix2(rateGroups[rate]), 0
        ]);
      });
    } else if(interState && inv.grandTotal > B2CL_THRESHOLD){
      const rateGroups = {};
      items.forEach(li => { rateGroups[li.gstRate] = (rateGroups[li.gstRate]||0) + li.taxable; });
      Object.keys(rateGroups).forEach(rate => {
        b2cl.push([
          inv.invoiceNo, inv.date, fix2(inv.grandTotal), poS(inv.customer),
          '', Number(rate), fix2(rateGroups[rate]), 0
        ]);
      });
    } else {
      items.forEach(li => {
        const key = poS(inv.customer) + '|' + li.gstRate;
        if(!b2csMap[key]) b2csMap[key] = { type: interState ? 'Inter State' : 'Intra State', place: poS(inv.customer), rate: li.gstRate, taxable: 0 };
        b2csMap[key].taxable += li.taxable;
      });
    }

    items.forEach(li => {
      const key = li.hsn + '|' + li.gstRate;
      if(!hsnMap[key]) hsnMap[key] = { hsn: li.hsn, desc: li.name, uqc: li.unit, qty: 0, value: 0, rate: li.gstRate, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
      const taxAmt = li.taxable * (li.gstRate||0) / 100;
      hsnMap[key].qty += li.qty;
      hsnMap[key].taxable += li.taxable;
      hsnMap[key].value += li.taxable + taxAmt;
      if(inv.sameState){ hsnMap[key].cgst += taxAmt/2; hsnMap[key].sgst += taxAmt/2; }
      else { hsnMap[key].igst += taxAmt; }
    });
  });

  const b2cs = Object.values(b2csMap).map(r => [r.type, r.place, '', Number(r.rate), fix2(r.taxable), 0]);
  const hsn = Object.values(hsnMap).map(r => [r.hsn, r.desc, r.uqc, r.qty, fix2(r.value), Number(r.rate), fix2(r.taxable), fix2(r.igst), fix2(r.cgst), fix2(r.sgst), 0]);

  gstr1Data = { period: period.fileTag, b2b, b2cl, b2cs, hsn };

  document.getElementById('gstrPeriodLabel').textContent = period.label;
  document.getElementById('gstrB2bCount').textContent = b2b.length;
  document.getElementById('gstrB2clCount').textContent = b2cl.length;
  document.getElementById('gstrB2csCount').textContent = b2cs.length;
  document.getElementById('gstrSummaryCard').classList.remove('hidden');
  showMsg('gstrMsg', `Found ${invoices.length} invoice(s) in this period.`, true);
}

function downloadGstr1Excel(){
  if(!gstr1Data) return;
  const wb = XLSX.utils.book_new();
  const b2bHeader = ['GSTIN/UIN of Recipient','Receiver Name','Invoice Number','Invoice date','Invoice Value','Place Of Supply','Reverse Charge','Applicable % of Tax Rate','Invoice Type','Rate','Taxable Value','Cess Amount'];
  const b2clHeader = ['Invoice Number','Invoice date','Invoice Value','Place Of Supply','Applicable % of Tax Rate','Rate','Taxable Value','Cess Amount'];
  const b2csHeader = ['Type','Place Of Supply','Applicable % of Tax Rate','Rate','Taxable Value','Cess Amount'];
  const hsnHeader = ['HSN','Description','UQC','Total Quantity','Total Value','Rate','Taxable Value','Integrated Tax Amount','Central Tax Amount','State/UT Tax Amount','Cess Amount'];

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([b2bHeader].concat(gstr1Data.b2b)), 'b2b');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([b2clHeader].concat(gstr1Data.b2cl)), 'b2cl');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([b2csHeader].concat(gstr1Data.b2cs)), 'b2cs');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hsnHeader].concat(gstr1Data.hsn)), 'hsn');

  XLSX.writeFile(wb, `GSTR1-${gstr1Data.period}.xlsx`);
}

/* ---------------- Utils ---------------- */
function fmtMoney(n){ return (n||0).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2}); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showMsg(id, text, ok){
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'error');
}

/* GSTIN format check + auto-select state from the embedded state code.
   No external API used — this is a pure client-side format/checksum-free
   validation (structure only) plus a lookup against INDIAN_STATES. */
function validateGstin(inputId, msgId, stateSelectId){
  const val = document.getElementById(inputId).value.trim().toUpperCase();
  document.getElementById(inputId).value = val;
  if(!val){ showMsg(msgId, '', true); return; }

  const pattern = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  if(!pattern.test(val)){
    showMsg(msgId, 'This doesn\'t look like a valid 15-character GSTIN — double-check for typos.', false);
    return;
  }

  const stateCode = val.slice(0,2);
  const stateName = stateNameByCode(stateCode);
  if(!stateName){
    showMsg(msgId, 'Valid format, but the state code "'+stateCode+'" isn\'t recognised — check the first two digits.', false);
    return;
  }

  const stateSelect = document.getElementById(stateSelectId);
  if(stateSelect) stateSelect.value = stateCode;
  showMsg(msgId, 'Looks valid — state auto-set to ' + stateName + '.', true);
}
