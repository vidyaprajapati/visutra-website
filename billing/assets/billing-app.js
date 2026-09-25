let currentUser = null;
let businessData = {};
let productsCache = [];
let customersCache = [];
let lineItems = []; // {productId, name, hsn, unit, qty, rate, discount, gstRate}
let suppliersCache = [];
let purchaseProductsCache = [];
let purchasesCache = [];
let paymentsCache = [];
let purchaseLineItems = []; // {productId, name, unit, qty, rate, gstRate} -- productId refers to purchaseProductsCache, NOT the billing Products list
let currentLedgerSupplierId = null;
let stockMovementsCache = [];
// Full, uncapped movement history — separate from stockMovementsCache above
// (which is capped at the last 200 for the History card), since the monthly
// report needs every movement on record to reconstruct opening/closing
// correctly for any month, not just the most recent ones. Lazily fetched
// once, reused after that.
let allStockMovementsCache = null;
let skuMappingsCache = [];
let stockUploadSheets = []; // {fileName, sheetName, headers, rows} — rows is an array of arrays, header row excluded
let stockAggregation = []; // {rawKey, displayKey, totalQty} built from stockUploadSheets after column mapping

// Same pdf.js build the buyer side's label-order.html uses, and the same
// shared extractAllMarketplaceItems()/hashText() from label-sku-extract.js
// (loaded in app.html) — this is a direct sale YOU fulfilled, so it just
// deducts stock immediately; no order, no supplier, no buyer involved.
if(typeof pdfjsLib !== 'undefined'){
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js".replace('pdf.min.js', 'pdf.worker.min.js');
}

/* Parse a date-only string ("YYYY-MM-DD", e.g. from <input type=date>) as a LOCAL
   date. new Date("YYYY-MM-DD") parses as UTC per spec, which for India (UTC+5:30)
   silently shifts the date back to the previous day when read back with local
   getters (getMonth/getDate/etc) — this broke financial-year invoice numbering
   and GSTR-1 period filtering for any invoice dated on a period boundary. Always
   use this instead of new Date(dateStr) for date-only strings in this file. */
function parseLocalDate(dateStr){
  if(!dateStr) return new Date(NaN);
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/* ---------------- Auth guard ---------------- */
auth.onAuthStateChanged(async user => {
  const verified = user && (user.emailVerified || user.providerData.some(p => p.providerId === 'google.com'));
  if(!verified){ window.location.href = 'login.html'; return; }

  try{
    const snap = await db.collection('users').doc(user.uid).get();
    if(!snap.exists || !snap.data().profileComplete){
      window.location.href = 'complete-profile.html?redirect=' + encodeURIComponent('app.html' + window.location.search);
      return;
    }

    currentUser = user;
    mountUserMenu('userMenuMount', user, { showBillingLink: false });
    populateStateSelect(document.getElementById('bizState'));
    populateStateSelect(document.getElementById('cState'));
    populateStateSelect(document.getElementById('sState'));
    document.getElementById('invDate').valueAsDate = new Date();
    document.getElementById('purDate').valueAsDate = new Date();
    document.getElementById('payEntryDate').valueAsDate = new Date();
    populateGstrFY();
    onFilingTypeChange();
    initSignaturePad();
    await loadProfile();
    await loadProducts();
    await loadCustomers();
    await loadSuppliers();
    await loadPurchaseProducts();
    await loadPayments();
    await loadReceipts();
    await loadPaymentConfirmations();
    await loadSkuMappings();
    await loadStockMovements();
    await loadLabelSkuQueue();
    addLineItem();
    addPurchaseLineItem();
    loadInvoices();
    loadPurchases();

    // Sidebar starts scoped to Business Profile only; the two buttons there
    // (or a deep link below) reveal the GST Billing or Purchase Entry pages.
    activateView('profile');

    // Deep-link support: e.g. app.html?view=purchases (used by the "Purchase
    // Data Entry" button on the main site) opens straight on that tab instead
    // of the default Business Profile view.
    const requestedView = new URLSearchParams(window.location.search).get('view');
    if(requestedView) activateView(requestedView);
  }catch(err){
    // Without this, any Firestore hiccup here (expired token, offline, a
    // permission error) throws inside an unhandled async callback and the
    // page is left however it happened to be — blank, with nothing but a
    // console error the user will never see. Show something actionable instead.
    console.error('App init failed:', err);
    document.body.innerHTML = `<div style="max-width:480px;margin:80px auto;text-align:center;font-family:sans-serif;color:#6B6255">
      <p>Something went wrong loading your account${err && (err.code || err.message) ? ` (${err.code || err.message})` : ''}.</p>
      <button onclick="location.reload()" style="padding:10px 20px;border-radius:8px;background:#C1440E;color:#fff;border:none;cursor:pointer">Retry</button>
    </div>`;
  }
});

/* ---------------- Nav ---------------- */
function activateView(viewName){
  const link = document.querySelector(`.nav-link[data-view="${viewName}"]`);
  const target = document.getElementById('view-' + viewName);
  if(!link || !target) return;
  document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
  link.classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  target.classList.remove('hidden');

  // Scope the sidebar: only the group ("billing" or "purchase") this view
  // belongs to stays visible. Business Profile has no data-group, so it's
  // untouched by this loop and always stays visible as the way back.
  const group = link.dataset.group || null;
  document.querySelectorAll('.nav-link[data-group]').forEach(l => {
    l.classList.toggle('hidden', l.dataset.group !== group);
  });

  // Keep the always-visible topbar switch buttons in sync so whichever mode
  // is active is visually marked, and either can be clicked to jump modes
  // from anywhere without going back to Business Profile.
  const billingBtn = document.getElementById('topbarBillingBtn');
  const purchaseBtn = document.getElementById('topbarPurchaseBtn');
  const stockBtn = document.getElementById('topbarStockBtn');
  if(billingBtn) billingBtn.classList.toggle('primary', group === 'billing');
  if(purchaseBtn) purchaseBtn.classList.toggle('primary', group === 'purchase');
  if(stockBtn) stockBtn.classList.toggle('primary', viewName === 'stock');

  // Centered topbar title always names the page you're currently on. The
  // Stock button's own label is short ("Stock") to fit the topbar pill
  // style, so show the fuller page name here instead of reusing it.
  const titleEl = document.getElementById('topbarTitle');
  if(titleEl) titleEl.textContent = viewName === 'stock' ? 'Stock Management' : link.textContent;

  if(viewName === 'invoices') loadInvoices();
  if(viewName === 'purchases') loadPurchases();
  if(viewName === 'trash') loadTrash();
  if(viewName === 'gstr1' && !purchasesCache.length) loadPurchases(); // preload so Purchases section has data without visiting Purchases first
}
document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    activateView(link.dataset.view);
  });
});

function signOut(){ auth.signOut().then(()=> window.location.href = 'login.html'); }

/* ---------------- Business profile ---------------- */
async function loadProfile(){
  const snap = await db.collection('users').doc(currentUser.uid).get();
  businessData = snap.data() || {};
  document.getElementById('bizLegalName').value = businessData.legalName || '';
  document.getElementById('bizName').value = businessData.businessName || '';
  document.getElementById('bizGstin').value = businessData.gstin || '';
  document.getElementById('bizAddress').value = businessData.address || '';
  document.getElementById('bizState').value = businessData.stateCode || '';
  document.getElementById('bizPhone').value = businessData.phone || '';
  if(businessData.signature){
    document.getElementById('sigPreview').src = businessData.signature;
    document.getElementById('sigPreviewWrap').classList.remove('hidden');
  }
  const bank = businessData.bankDetails || {};
  document.getElementById('bankHolderName').value = bank.holderName || '';
  document.getElementById('bankName').value = bank.bankName || '';
  document.getElementById('bankAccountNumber').value = bank.accountNumber || '';
  document.getElementById('bankIfsc').value = bank.ifsc || '';
  document.getElementById('bankUpiId').value = bank.upiId || '';
  if(bank.qrImage){
    document.getElementById('bankQrPreview').src = bank.qrImage;
    document.getElementById('bankQrPreviewWrap').classList.remove('hidden');
  }
}

async function saveProfile(){
  const stateCode = document.getElementById('bizState').value;
  const data = {
    legalName: document.getElementById('bizLegalName').value.trim(),
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

/* ---------------- Signature pad (draw or upload) ---------------- */
let sigCtx, drawing = false;
let sigMode = 'draw';          // 'draw' | 'upload'
let uploadedSigDataUrl = null; // set once an uploaded image has been converted, ready to save

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

function setSignatureMode(mode){
  sigMode = mode;
  document.getElementById('sigDrawPanel').classList.toggle('hidden', mode !== 'draw');
  document.getElementById('sigUploadPanel').classList.toggle('hidden', mode !== 'upload');
  document.getElementById('sigModeDrawBtn').classList.toggle('primary', mode === 'draw');
  document.getElementById('sigModeUploadBtn').classList.toggle('primary', mode === 'upload');
}

function handleSignatureUpload(evt){
  const file = evt.target.files && evt.target.files[0];
  uploadedSigDataUrl = null;
  if(!file) return;
  if(file.type !== 'image/png' && file.type !== 'image/jpeg'){
    showMsg('sigMsg', 'Please choose a JPG or PNG image.', false);
    evt.target.value = '';
    return;
  }
  if(file.size > 5 * 1024 * 1024){
    showMsg('sigMsg', 'That image is too large — please use one under 5MB.', false);
    evt.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // Drawn onto the same 400x150 box the signature pad uses, preserving aspect
      // ratio. This also keeps the saved signature small (well under Firestore's
      // 1MB document limit) no matter how large the original photo/scan was.
      const canvas = document.getElementById('sigUploadPreview');
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / img.width, canvas.height / img.height, 1);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      uploadedSigDataUrl = canvas.toDataURL('image/png');
    };
    img.onerror = () => showMsg('sigMsg', 'Could not read that image file.', false);
    img.src = reader.result;
  };
  reader.onerror = () => showMsg('sigMsg', 'Could not read that image file.', false);
  reader.readAsDataURL(file);
}

async function saveSignature(){
  let dataUrl;
  if(sigMode === 'upload'){
    if(!uploadedSigDataUrl){ showMsg('sigMsg', 'Choose a JPG or PNG image first.', false); return; }
    dataUrl = uploadedSigDataUrl;
  } else {
    dataUrl = document.getElementById('sigPad').toDataURL('image/png');
  }
  await db.collection('users').doc(currentUser.uid).set({signature: dataUrl}, {merge:true});
  businessData.signature = dataUrl;
  document.getElementById('sigPreview').src = dataUrl;
  document.getElementById('sigPreviewWrap').classList.remove('hidden');
  showMsg('sigMsg', 'Signature saved.', true);
}

/* ---------------- Bank Details ---------------- */
let uploadedBankQrDataUrl = null;
function handleBankQrUpload(evt){
  const file = evt.target.files && evt.target.files[0];
  uploadedBankQrDataUrl = null;
  if(!file) return;
  if(file.type !== 'image/png' && file.type !== 'image/jpeg'){
    showMsg('bankMsg', 'Please choose a JPG or PNG image.', false);
    evt.target.value = '';
    return;
  }
  if(file.size > 5 * 1024 * 1024){
    showMsg('bankMsg', 'That image is too large — please use one under 5MB.', false);
    evt.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // Scaled into a 180x180 square (QR codes are square, unlike the
      // signature's wide box) — keeps the saved image comfortably under
      // Firestore's 1MB document field limit regardless of the source photo.
      const canvas = document.getElementById('bankQrUploadPreview');
      canvas.classList.remove('hidden');
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / img.width, canvas.height / img.height, 1);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      uploadedBankQrDataUrl = canvas.toDataURL('image/png');
    };
    img.onerror = () => showMsg('bankMsg', 'Could not read that image file.', false);
    img.src = reader.result;
  };
  reader.onerror = () => showMsg('bankMsg', 'Could not read that image file.', false);
  reader.readAsDataURL(file);
}
async function saveBankDetails(){
  const bankDetails = {
    holderName: document.getElementById('bankHolderName').value.trim(),
    bankName: document.getElementById('bankName').value.trim(),
    accountNumber: document.getElementById('bankAccountNumber').value.trim(),
    ifsc: document.getElementById('bankIfsc').value.trim(),
    upiId: document.getElementById('bankUpiId').value.trim(),
    qrImage: uploadedBankQrDataUrl || (businessData.bankDetails && businessData.bankDetails.qrImage) || ''
  };
  await db.collection('users').doc(currentUser.uid).set({ bankDetails }, {merge: true});
  businessData.bankDetails = bankDetails;
  if(bankDetails.qrImage){
    document.getElementById('bankQrPreview').src = bankDetails.qrImage;
    document.getElementById('bankQrPreviewWrap').classList.remove('hidden');
  }
  uploadedBankQrDataUrl = null;
  document.getElementById('bankQrFileInput').value = '';
  document.getElementById('bankQrUploadPreview').classList.add('hidden');
  showMsg('bankMsg', 'Bank details saved.', true);
}
async function removeBankQr(){
  if(!confirm('Remove the saved payment QR code?')) return;
  const bankDetails = { ...(businessData.bankDetails || {}), qrImage: '' };
  await db.collection('users').doc(currentUser.uid).set({ bankDetails }, {merge: true});
  businessData.bankDetails = bankDetails;
  document.getElementById('bankQrPreviewWrap').classList.add('hidden');
  document.getElementById('bankQrPreview').src = '';
  showMsg('bankMsg', 'QR code removed.', true);
}

/* ---------------- Products ---------------- */
async function loadProducts(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('products').orderBy('name').get();
  productsCache = snap.docs.map(d => ({id:d.id, ...d.data()}));
  renderProducts();
  renderProductDropdowns();
  renderStockDropdowns();
  renderStockTable();
}
function renderProducts(){
  document.getElementById('productsTable').innerHTML = productsCache.map(p => {
    const isActive = p.active !== false; // missing = treat as active (backward compatible with products created before this field existed)
    const isVisible = !!p.buyerVisibility;
    return `
    <tr><td>${esc(p.name)}</td><td>${esc(p.sku||'—')}</td><td>${esc(p.hsn)}</td><td>${esc(p.unit)}</td><td>₹${fmtMoney(p.price)}</td><td>${p.gstRate}%</td><td>₹${fmtMoney(p.price * (1 + (p.gstRate||0)/100))}</td><td>${p.stock||0}</td><td>${p.reorderLevel||0}</td>
    <td><button class="btn small" onclick="toggleProductActive('${p.id}', ${!isActive})">${isActive ? 'Active ✓' : 'Inactive'}</button></td>
    <td><button class="btn small" onclick="toggleBuyerVisibility('${p.id}', ${!isVisible})" title="Whether linked buyer accounts can see this product">${isVisible ? 'Visible ✓' : 'Hidden'}</button></td>
    <td class="row-actions">
      <button class="btn small" onclick="editProduct('${p.id}')">Edit</button>
      <button class="btn small danger" onclick="deleteProduct('${p.id}')">Delete</button>
    </td></tr>`;
  }).join('') || '<tr><td colspan="12" style="color:var(--muted)">No products yet.</td></tr>';
}
/* Quick toggles from the table row — no need to open the edit form for these two flags. */
async function toggleProductActive(id, newVal){
  await db.collection('users').doc(currentUser.uid).collection('products').doc(id).update({active: newVal});
  loadProducts();
}
async function toggleBuyerVisibility(id, newVal){
  await db.collection('users').doc(currentUser.uid).collection('products').doc(id).update({buyerVisibility: newVal});
  loadProducts();
}
function updateProductExclusivePreview(){
  const incl = parseFloat(document.getElementById('pPriceIncl').value) || 0;
  const gstRate = parseFloat(document.getElementById('pGst').value) || 0;
  const excl = gstRate ? incl / (1 + gstRate/100) : incl;
  document.getElementById('pPrice').value = excl.toFixed(2);
}
async function saveProduct(){
  const id = document.getElementById('pEditId').value;
  const inclPrice = parseFloat(document.getElementById('pPriceIncl').value) || 0;
  const gstRate = parseFloat(document.getElementById('pGst').value);
  const exclPrice = Math.round((gstRate ? inclPrice / (1 + gstRate/100) : inclPrice) * 100) / 100;
  const existing = id ? productsCache.find(p => p.id === id) : null;
  const data = {
    name: document.getElementById('pName').value.trim(),
    hsn: document.getElementById('pHsn').value.trim(),
    unit: document.getElementById('pUnit').value.trim() || 'PCS',
    sku: document.getElementById('pSku').value.trim(),
    price: exclPrice, // stored as the excl.-GST taxable value, used as-is everywhere downstream (invoicing, GSTR-1)
    gstRate,
    reorderLevel: parseFloat(document.getElementById('pReorderLevel').value) || 0,
    stock: existing ? (existing.stock || 0) : 0, // stock is only ever changed via purchases, monthly uploads, or Adjust Stock — never reset by editing product details
    active: existing ? (existing.active !== false) : true,
    buyerVisibility: existing ? !!existing.buyerVisibility : false // off by default; turn on per-product from the table once a buyer is linked
  };
  if(!data.name){ showMsg('productMsg', 'Product name is required.', false); return; }
  const col = db.collection('users').doc(currentUser.uid).collection('products');
  if(id){ await col.doc(id).set(data); } else { await col.add(data); }
  ['pName','pHsn','pUnit','pSku','pPriceIncl','pPrice','pReorderLevel','pEditId'].forEach(f => document.getElementById(f).value = '');
  document.getElementById('pGst').value = '0';
  showMsg('productMsg', 'Saved.', true);
  await loadProducts();
  // A new/renamed sellable Product might now name-match an existing,
  // still-unlinked Purchase Product — re-run the auto-link pass so that
  // pairing connects immediately instead of waiting for the next page load.
  if(purchaseProductsCache.length){ await autoLinkPurchaseProducts(); renderPurchaseProducts(); }
}
function editProduct(id){
  const p = productsCache.find(x => x.id === id);
  document.getElementById('pEditId').value = id;
  document.getElementById('pName').value = p.name;
  document.getElementById('pHsn').value = p.hsn;
  document.getElementById('pUnit').value = p.unit;
  document.getElementById('pSku').value = p.sku || '';
  document.getElementById('pPriceIncl').value = (p.price * (1 + (p.gstRate||0)/100)).toFixed(2);
  document.getElementById('pGst').value = p.gstRate;
  document.getElementById('pReorderLevel').value = p.reorderLevel || 0;
  updateProductExclusivePreview();
}
async function deleteProduct(id){
  if(!confirm('Delete this product?')) return;
  await db.collection('users').doc(currentUser.uid).collection('products').doc(id).delete();
  loadProducts();
}

/* ---------------- Stock Management ---------------- */
function renderStockDropdowns(){
  const sel = document.getElementById('adjProduct');
  if(sel){
    const prev = sel.value;
    sel.innerHTML = '<option value="">Select product…</option>' +
      productsCache.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if(prev && productsCache.some(p => p.id === prev)) sel.value = prev;
  }
  const ppSel = document.getElementById('ppLinkedProduct');
  if(ppSel){
    const prev = ppSel.value;
    ppSel.innerHTML = '<option value="">Auto-detect by matching name — or pick one</option>' +
      productsCache.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if(prev && productsCache.some(p => p.id === prev)) ppSel.value = prev;
  }
}
function renderStockTable(){
  const tbody = document.getElementById('stockTable');
  if(!tbody) return;
  tbody.innerHTML = productsCache.map(p => `
    <tr><td>${esc(p.name)}</td><td>${esc(p.unit)}</td><td>${p.stock || 0}</td><td>${p.reorderLevel || 0}</td></tr>
  `).join('') || '<tr><td colspan="4" style="color:var(--muted)">No products yet.</td></tr>';
  renderReorderTable();
}
function renderReorderTable(){
  const tbody = document.getElementById('reorderTable');
  if(!tbody) return;
  const low = productsCache
    .filter(p => (p.reorderLevel || 0) > 0 && (p.stock || 0) <= p.reorderLevel)
    .sort((a,b) => ((a.stock||0) - a.reorderLevel) - ((b.stock||0) - b.reorderLevel));
  tbody.innerHTML = low.map(p => `
    <tr><td>${esc(p.name)}</td><td>${p.stock || 0}</td><td>${p.reorderLevel}</td><td>${Math.max(0, p.reorderLevel - (p.stock||0))}</td></tr>
  `).join('') || '<tr><td colspan="4" style="color:var(--muted)">Nothing needs reordering right now.</td></tr>';
}
function renderStockMovementsTable(){
  const tbody = document.getElementById('stockMovementsTable');
  if(!tbody) return;
  tbody.innerHTML = stockMovementsCache.filter(m => dateInRange(m.date, 'stockMoveFrom', 'stockMoveTo')).map(m => `
    <tr><td>${esc(m.date)}</td><td><span class="badge">${esc(m.type)}</span></td><td>${esc(m.productName)}</td><td>${m.qty > 0 ? '+' : ''}${m.qty}</td><td>${esc(m.note||'')}</td></tr>
  `).join('') || '<tr><td colspan="5" style="color:var(--muted)">No stock movements yet.</td></tr>';
}
async function loadSkuMappings(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('skuMappings').orderBy('rawKey').get();
  skuMappingsCache = snap.docs.map(d => ({id:d.id, ...d.data()}));
  renderSkuMappingsTable();
}
// Standing management view of every SKU -> Product mapping, whether it was
// created here, from an unrecognized label SKU, or from the Monthly
// Inventory Reconciliation upload — all three write to the same
// skuMappings collection, so this one table covers all of them.
function renderSkuMappingsTable(){
  const table = document.getElementById('skuMappingsTable');
  if(!table) return;
  const productSelect = document.getElementById('skuMapProduct');
  if(productSelect){
    const prev = productSelect.value;
    productSelect.innerHTML = '<option value="">Select product…</option>' + productsCache.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if(prev) productSelect.value = prev;
  }
  table.innerHTML = skuMappingsCache.map(m => `
    <tr><td>${esc(m.rawKey)}</td><td>${esc(m.productName)}</td>
    <td class="row-actions">
      <button class="btn small" onclick="editSkuMapping('${m.id}')">Edit</button>
      <button class="btn small danger" onclick="deleteSkuMapping('${m.id}')">Delete</button>
    </td></tr>
  `).join('') || '<tr><td colspan="3" style="color:var(--muted)">No SKU mappings yet — add one below, or one gets created automatically the first time you map an unrecognized label SKU or reconciliation row.</td></tr>';
}
async function saveSkuMapping(){
  const rawKey = document.getElementById('skuMapRawKey').value.trim();
  const productId = document.getElementById('skuMapProduct').value;
  const editId = document.getElementById('skuMapEditId').value;
  const product = productsCache.find(p => p.id === productId);
  if(!rawKey){ showMsg('skuMappingMsg', 'Enter the marketplace SKU.', false); return; }
  if(!product){ showMsg('skuMappingMsg', 'Select a product.', false); return; }

  const dupe = skuMappingsCache.find(m => m.rawKey.toLowerCase() === rawKey.toLowerCase() && m.id !== editId);
  if(dupe){ showMsg('skuMappingMsg', `"${rawKey}" is already mapped to ${dupe.productName} — edit that one instead of creating a duplicate.`, false); return; }

  const data = { rawKey, productId, productName: product.name };
  if(editId){
    await db.collection('users').doc(currentUser.uid).collection('skuMappings').doc(editId).set(data, {merge: true});
  } else {
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await db.collection('users').doc(currentUser.uid).collection('skuMappings').add(data);
  }
  resetSkuMappingForm();
  await loadSkuMappings();
  showMsg('skuMappingMsg', `Saved — ${rawKey} → ${product.name}.`, true);
}
function editSkuMapping(id){
  const m = skuMappingsCache.find(x => x.id === id);
  if(!m) return;
  document.getElementById('skuMapEditId').value = id;
  document.getElementById('skuMapRawKey').value = m.rawKey;
  document.getElementById('skuMapProduct').value = m.productId;
  document.getElementById('skuMapFormTitle').textContent = 'Edit SKU Mapping';
  document.getElementById('skuMapCancelBtn').style.display = 'inline-block';
}
function resetSkuMappingForm(){
  document.getElementById('skuMapEditId').value = '';
  document.getElementById('skuMapRawKey').value = '';
  document.getElementById('skuMapProduct').value = '';
  document.getElementById('skuMapFormTitle').textContent = 'Add a SKU Mapping';
  document.getElementById('skuMapCancelBtn').style.display = 'none';
}
async function deleteSkuMapping(id){
  if(!confirm('Delete this SKU mapping? Labels or reconciliation rows with this SKU will need mapping again next time.')) return;
  await db.collection('users').doc(currentUser.uid).collection('skuMappings').doc(id).delete();
  await loadSkuMappings();
}
async function loadStockMovements(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('stockMovements').orderBy('createdAt','desc').limit(200).get();
  stockMovementsCache = snap.docs.map(d => ({id:d.id, ...d.data()}));
  renderStockMovementsTable();
  // Every place that calls loadStockMovements() does so because stock just
  // changed, so keep the Monthly Stock Report in sync the same way — it's
  // a no-op before the month input exists yet (very first load, handled
  // explicitly right after this call returns).
  if(document.getElementById('stockReportMonth')) await renderMonthlyStockReport();
  sellerRenderSalesReorder();
}

/* ---------------- Monthly Stock Report (Opening / Closing + daily movement) ----------------
   Reconstructed from the full stockMovements history rather than stored
   per-day, since every stock change (purchase-in, sale-out, adjustment,
   reconciliation) already writes a movement here (see addStockMovement) —
   so working backwards from the current live stock gives an exact
   opening/closing balance for any month, without needing a separate
   snapshot. Uses allStockMovementsCache (uncapped), not stockMovementsCache
   (capped at 200 for the History card above), since a month outside the
   most recent 200 movements would otherwise be miscalculated. */
async function ensureAllStockMovementsLoaded(){
  if(allStockMovementsCache) return allStockMovementsCache;
  const snap = await db.collection('users').doc(currentUser.uid).collection('stockMovements').orderBy('date').get();
  allStockMovementsCache = snap.docs.map(d => ({id:d.id, ...d.data()}));
  return allStockMovementsCache;
}
function stockReportMonthBounds(monthStr){
  const [y, m] = monthStr.split('-').map(Number);
  const start = `${monthStr}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${monthStr}-${String(lastDay).padStart(2,'0')}`;
  return { start, end };
}
async function renderMonthlyStockReport(){
  const monthInput = document.getElementById('stockReportMonth');
  if(!monthInput) return;
  const month = monthInput.value || new Date().toISOString().slice(0,7);
  monthInput.value = month;
  const { start, end } = stockReportMonthBounds(month);
  const movements = await ensureAllStockMovementsLoaded();

  const rows = productsCache.map(p => {
    const pm = movements.filter(m => m.productId === p.id);
    // Roll the live stock back past everything that happened AFTER this
    // month to get the balance as it stood at month-end.
    const afterEnd = pm.filter(m => m.date > end).reduce((s,m) => s + (m.qty||0), 0);
    const closing = (p.stock || 0) - afterEnd;
    const inMonth = pm.filter(m => m.date >= start && m.date <= end);
    const netInMonth = inMonth.reduce((s,m) => s + (m.qty||0), 0);
    const opening = closing - netInMonth;
    const stockIn = inMonth.filter(m => m.qty > 0).reduce((s,m) => s + m.qty, 0);
    const stockOut = inMonth.filter(m => m.qty < 0).reduce((s,m) => s + m.qty, 0);
    return { product: p, opening, stockIn, stockOut, closing };
  });
  const reportTable = document.getElementById('monthlyStockReportTable');
  if(reportTable){
    reportTable.innerHTML = rows.map(r => `
      <tr><td>${esc(r.product.name)}</td><td>${r.opening}</td><td style="color:#0E7C6B">${r.stockIn?'+':''}${r.stockIn}</td><td style="color:var(--paprika-dark)">${r.stockOut}</td><td><b>${r.closing}</b></td></tr>
    `).join('') || '<tr><td colspan="5" style="color:var(--muted)">No products yet.</td></tr>';
  }

  const dayMovs = movements.filter(m => m.date >= start && m.date <= end).sort((a,b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));
  const dailyTable = document.getElementById('dailyStockMovementTable');
  if(dailyTable){
    dailyTable.innerHTML = dayMovs.map(m => `
      <tr><td>${esc(m.date)}</td><td>${esc(m.productName)}</td><td>${m.qty>0?'+':''}${m.qty}</td><td>${esc(m.note||'')}</td></tr>
    `).join('') || '<tr><td colspan="4" style="color:var(--muted)">No movements in this month.</td></tr>';
  }
}
/* Shared by purchase stock-in and manual adjustment: bumps a product's stock
   by qty (can be negative) and logs the movement for the history table. */
async function addStockMovement(type, productId, qty, date, note){
  const product = productsCache.find(p => p.id === productId);
  if(!product || !qty) return;
  await db.collection('users').doc(currentUser.uid).collection('products').doc(productId).update({
    stock: firebase.firestore.FieldValue.increment(qty)
  });
  await db.collection('users').doc(currentUser.uid).collection('stockMovements').add({
    type, productId, productName: product.name, qty, date, note: note || '',
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  // Every stock change funnels through here, so invalidating in one place
  // keeps the Monthly Stock Report correct without touching each call site.
  allStockMovementsCache = null;
}
async function adjustStock(){
  const productId = document.getElementById('adjProduct').value;
  const qty = parseFloat(document.getElementById('adjQty').value);
  const note = document.getElementById('adjNote').value.trim();
  if(!productId){ showMsg('adjMsg', 'Select a product first.', false); return; }
  if(!qty){ showMsg('adjMsg', 'Enter a non-zero quantity change.', false); return; }
  await addStockMovement('adjustment', productId, qty, new Date().toISOString().slice(0,10), note);
  await loadProducts();
  await loadStockMovements();
  document.getElementById('adjQty').value = '';
  document.getElementById('adjNote').value = '';
  showMsg('adjMsg', 'Stock adjusted.', true);
}

/* --- Monthly marketplace sales upload: read files -> map columns -> aggregate -> match products -> apply ---
   Meesho and Flipkart reports are detected by their actual column headers
   (not file name or sheet name, which vary) and get their status column
   read automatically — DELIVERED reduces stock, CANCELLED/RTO/RETURNED adds
   it back, since a returned item physically comes back into your inventory
   rather than just vanishing from stock like a real sale would. Anything
   that doesn't match a known format falls back to the original manual
   column picker (Amazon, or anything else), which — same as before — has
   no way to tell a return from a sale and treats every row as sold. */
const STOCK_PRODUCT_COL_GUESSES = ['sku','product name','item description','product title/description','description','product'];
const STOCK_QTY_COL_GUESSES = ['quantity','qty','item quantity'];
function guessStockColumn(headers, candidates){
  const lower = headers.map(h => String(h).toLowerCase());
  for(const c of candidates){ const i = lower.findIndex(h => h === c); if(i !== -1) return i; }
  for(const c of candidates){ const i = lower.findIndex(h => h.includes(c)); if(i !== -1) return i; }
  return -1; // no match at all — caller decides whether that disqualifies the sheet
}
// Rows whose status/reason contains any of these mean the item came back to
// you (cancelled before dispatch counts too — it's stock that never left).
const RETURN_STATUS_PATTERN = /cancel|rto|return/i;
function detectSheetFormat(headers){
  const lower = headers.map(h => String(h||'').trim().toLowerCase());
  const idx = name => lower.indexOf(name);
  // Order-ID column (if the report has one) — lets each row be matched to
  // the exact shipment a printed label / Returns box already counted.
  const findHdr = test => lower.findIndex(test);
  if(idx('reason for credit entry') !== -1 && idx('sku') !== -1 && idx('quantity') !== -1){
    return { format: 'meesho', reasonIdx: idx('reason for credit entry'), skuIdx: idx('sku'), qtyIdx: idx('quantity'), nameIdx: idx('product name'),
      orderIdx: findHdr(h => h.includes('sub order') || h.includes('suborder')) };
  }
  if(idx('order date') !== -1 && idx('sku name') !== -1 && idx('order status') !== -1 && idx('gross units') !== -1){
    return { format: 'flipkart-pnl', skuIdx: idx('sku name'), statusIdx: idx('order status'), qtyIdx: idx('gross units'),
      orderIdx: findHdr(h => h === 'order id' || h === 'order_id' || h.includes('order id')) };
  }
  return null;
}
async function parseStockFiles(){
  const input = document.getElementById('stockFiles');
  const files = input.files;
  if(!files || !files.length){ showMsg('stockUploadMsg', 'Choose at least one file first.', false); return; }
  stockUploadSheets = [];
  for(const file of files){
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, {type:'array'});
    wb.SheetNames.forEach(sheetName => {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {header:1, raw:true, defval:''});
      if(!rows.length) return;
      const headers = rows[0].map(h => String(h||'').trim());
      const dataRows = rows.slice(1).filter(r => r.some(c => c !== '' && c !== undefined && c !== null));
      if(!headers.length || !dataRows.length) return;
      const detected = detectSheetFormat(headers);
      // For anything not auto-detected (Amazon, a different report layout,
      // or a same-file secondary sheet like Flipkart's own summary tabs),
      // only keep it if it plausibly has BOTH a product-like and a
      // quantity-like column — otherwise it's not order-level data at all
      // (e.g. a "Report Help" text sheet) and showing it for manual mapping
      // would just be confusing.
      if(!detected){
        const prodGuess = guessStockColumn(headers, STOCK_PRODUCT_COL_GUESSES);
        const qtyGuess = guessStockColumn(headers, STOCK_QTY_COL_GUESSES);
        if(prodGuess === -1 || qtyGuess === -1) return;
      }
      stockUploadSheets.push({ fileName: file.name, sheetName, headers, rows: dataRows, detected });
    });
  }
  if(!stockUploadSheets.length){ showMsg('stockUploadMsg', 'Could not find any readable order data in the selected files.', false); return; }
  renderStockColumnMapUI();
  const autoCount = stockUploadSheets.filter(s => s.detected).length;
  showMsg('stockUploadMsg', `Read ${stockUploadSheets.length} sheet(s) from ${files.length} file(s).` +
    (autoCount ? ` ${autoCount} recognised automatically (Meesho/Flipkart) — returns and cancellations will be added back to stock, not deducted.` : ' Pick the product and quantity column for each below.'), true);
}
function renderStockColumnMapUI(){
  document.getElementById('stockColumnMapWrap').classList.remove('hidden');
  document.getElementById('stockAggWrap').classList.add('hidden');
  document.getElementById('stockColumnMapList').innerHTML = stockUploadSheets.map((s, i) => {
    if(s.detected){
      const label = s.detected.format === 'meesho' ? 'Meesho' : 'Flipkart Orders P&L';
      return `<div class="box" style="margin-bottom:10px">
        <p style="margin:0;font-size:13px"><span class="badge">${label} — detected automatically</span></p>
        <p style="margin:6px 0 0;font-size:13px;color:var(--muted)">${esc(s.fileName)} — ${esc(s.sheetName)} (${s.rows.length} rows). Status/reason column read automatically — no columns to pick.</p>
      </div>`;
    }
    const opts = s.headers.map((h, ci) => `<option value="${ci}">${esc(h || ('(column ' + (ci+1) + ')'))}</option>`).join('');
    return `<div class="box" style="margin-bottom:10px">
      <p style="margin:0 0 8px;font-size:13px;color:var(--muted)">${esc(s.fileName)} — ${esc(s.sheetName)} (${s.rows.length} rows) — unrecognised format, every row here will be treated as a sale (no return/cancellation detection).</p>
      <div class="grid2">
        <div class="field"><label>Product / SKU column</label><select id="stockColProd${i}">${opts}</select></div>
        <div class="field"><label>Quantity column</label><select id="stockColQty${i}">${opts}</select></div>
      </div>
    </div>`;
  }).join('');
  stockUploadSheets.forEach((s, i) => {
    if(s.detected) return;
    const prodGuess = guessStockColumn(s.headers, STOCK_PRODUCT_COL_GUESSES);
    const qtyGuess = guessStockColumn(s.headers, STOCK_QTY_COL_GUESSES);
    document.getElementById('stockColProd'+i).value = prodGuess === -1 ? 0 : prodGuess;
    document.getElementById('stockColQty'+i).value = qtyGuess === -1 ? 0 : qtyGuess;
  });
}
async function aggregateStockUpload(){
  // normalized SKU/text -> {displayKey, soldQty, returnedQty, skippedQty, skippedStatuses}
  const agg = new Map();
  function bump(raw, qty, isReturn){
    if(!raw) return;
    const key = raw.toLowerCase();
    if(!agg.has(key)) agg.set(key, { displayKey: raw, soldQty: 0, returnedQty: 0, skippedQty: 0, skippedStatuses: new Set(), alreadyQty: 0, linkedRows: [] });
    const entry = agg.get(key);
    if(isReturn) entry.returnedQty += qty; else entry.soldQty += qty;
  }
  // Rows from Meesho/Flipkart reports that carry an order ID are held back
  // and checked against labels already printed / returns already added
  // (label-stock-core.js → linkReconRows) before they're counted.
  const held = [];
  function hold(mk, raw, qty, isReturn, orderId){
    if(orderId) held.push({ marketplace: mk, sku: raw, orderId, qty, isReturn });
    else bump(raw, qty, isReturn);
  }

  stockUploadSheets.forEach((s, i) => {
    if(s.detected && s.detected.format === 'meesho'){
      const { reasonIdx, skuIdx, qtyIdx, orderIdx } = s.detected;
      s.rows.forEach(row => {
        const sku = String(row[skuIdx] ?? '').trim();
        if(!sku) return;
        const qty = parseFloat(row[qtyIdx]) || 0;
        const reason = String(row[reasonIdx] ?? '').trim();
        const orderId = orderIdx >= 0 ? String(row[orderIdx] ?? '').trim() : '';
        if(RETURN_STATUS_PATTERN.test(reason)) hold('MEESHO', sku, qty, true, orderId);
        else if(/delivered/i.test(reason)) hold('MEESHO', sku, qty, false, orderId);
        // Anything else (DOOR_STEP_EXCHANGED, LOST, unrecognised) is left
        // untouched deliberately — neither a clean sale nor a stock return,
        // and guessing wrong in either direction would misstate inventory.
      });
    } else if(s.detected && s.detected.format === 'flipkart-pnl'){
      const { skuIdx, statusIdx, qtyIdx, orderIdx } = s.detected;
      s.rows.forEach(row => {
        const sku = String(row[skuIdx] ?? '').trim();
        if(!sku) return;
        const qty = parseFloat(row[qtyIdx]) || 0;
        const status = String(row[statusIdx] ?? '').trim();
        const orderId = orderIdx >= 0 ? String(row[orderIdx] ?? '').trim() : '';
        if(RETURN_STATUS_PATTERN.test(status)) hold('FLIPKART', sku, qty, true, orderId);
        else if(/delivered/i.test(status)) hold('FLIPKART', sku, qty, false, orderId);
      });
    } else {
      // Unrecognised format — same behaviour as before this change: every
      // row counts as a plain sale, since there's no status column to tell
      // a return apart from a delivery.
      const prodIdx = parseInt(document.getElementById('stockColProd'+i).value, 10);
      const qtyIdx = parseInt(document.getElementById('stockColQty'+i).value, 10);
      s.rows.forEach(row => {
        const raw = String(row[prodIdx] ?? '').trim();
        if(!raw) return;
        bump(raw, parseFloat(row[qtyIdx]) || 0, false);
      });
    }
  });

  if(held.length){
    await VLS.linkReconRows(currentUser.uid, 'seller', held);
    held.forEach(r => {
      if(!r.key || r.status === 'new'){
        bump(r.sku, r.qty, r.isReturn);
        if(r.key) agg.get(r.sku.toLowerCase()).linkedRows.push(r);
      } else {
        // 'already' = that label/return was counted before; 'never-sold' =
        // a return for something that was never deducted (e.g. cancelled
        // before printing) — neither changes stock now.
        bump(r.sku, 0, false);
        agg.get(r.sku.toLowerCase()).alreadyQty += r.qty;
      }
    });
  }

  stockAggregation = Array.from(agg.entries())
    .map(([rawKey, v]) => ({ rawKey, displayKey: v.displayKey, soldQty: v.soldQty, returnedQty: v.returnedQty, netChange: v.returnedQty - v.soldQty, alreadyQty: v.alreadyQty, linkedRows: v.linkedRows }))
    .filter(r => r.soldQty !== 0 || r.returnedQty !== 0 || r.alreadyQty !== 0)
    .sort((a,b) => Math.abs(b.netChange) - Math.abs(a.netChange));
  renderStockAggregationTable();
}
function renderStockAggregationTable(){
  const wrap = document.getElementById('stockAggWrap');
  if(!stockAggregation.length){
    wrap.classList.add('hidden');
    showMsg('stockUploadMsg', 'No quantities found with the columns you picked — check the column selection above.', false);
    return;
  }
  wrap.classList.remove('hidden');
  document.getElementById('stockAggTable').innerHTML = stockAggregation.map((r, i) => {
    const known = skuMappingsCache.find(m => m.rawKey === r.rawKey);
    const options = ['<option value="">Skip — not a stock item</option>']
      .concat(productsCache.map(p => `<option value="${p.id}" ${known && known.productId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`));
    const netStyle = r.netChange < 0 ? 'color:var(--paprika-dark)' : (r.netChange > 0 ? 'color:#0E7C6B' : '');
    return `<tr${known ? '' : ' style="background:#FFF7ED"'}>
      <td>${esc(r.displayKey)}${known ? '' : ' <span class="badge" title="No saved mapping yet — pick a product on the right">Unmapped</span>'}</td>
      <td>${r.soldQty || 0}</td>
      <td>${r.returnedQty || 0}</td>
      <td style="color:var(--muted)">${r.alreadyQty || 0}</td>
      <td style="${netStyle}">${r.netChange > 0 ? '+' : ''}${r.netChange}</td>
      <td><select id="stockAggMap${i}">${options.join('')}</select></td>
    </tr>`;
  }).join('');
}
async function applyStockUpload(){
  const period = document.getElementById('stockPeriod').value.trim() || new Date().toISOString().slice(0,7);
  const dateVal = new Date().toISOString().slice(0,10);
  let applied = 0;

  for(let i = 0; i < stockAggregation.length; i++){
    const row = stockAggregation[i];
    const sel = document.getElementById('stockAggMap'+i);
    const productId = sel ? sel.value : '';
    if(!productId) continue;
    const product = productsCache.find(p => p.id === productId);
    if(!product) continue;

    // Remember this product/SKU -> product mapping for future months.
    const existingMap = skuMappingsCache.find(m => m.rawKey === row.rawKey);
    if(existingMap){
      if(existingMap.productId !== productId){
        await db.collection('users').doc(currentUser.uid).collection('skuMappings').doc(existingMap.id)
          .set({ rawKey: row.rawKey, productId, productName: product.name });
      }
    } else {
      await db.collection('users').doc(currentUser.uid).collection('skuMappings').add({
        rawKey: row.rawKey, productId, productName: product.name, createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }

    if(row.soldQty) await addStockMovement('sale-out', productId, -row.soldQty, dateVal, `${period} — ${row.displayKey} (sold)`);
    if(row.returnedQty) await addStockMovement('return-in', productId, row.returnedQty, dateVal, `${period} — ${row.displayKey} (cancelled/RTO/returned)`);
    // Mark the linked rows so labels, the Returns box and a re-upload of
    // this report all see them as already counted.
    try{ await VLS.markReconRows(currentUser.uid, 'seller', row.linkedRows || [], productId, 'reconciliation'); }
    catch(err){ console.error('Could not mark reconciled orders:', err); }
    applied++;
  }

  await loadProducts();
  await loadSkuMappings();
  await loadStockMovements();

  document.getElementById('stockColumnMapWrap').classList.add('hidden');
  document.getElementById('stockAggWrap').classList.add('hidden');
  document.getElementById('stockFiles').value = '';
  stockUploadSheets = [];
  stockAggregation = [];
  showMsg('stockUploadMsg', `Stock updated for ${applied} product(s).`, true);
}

/* ---------------- Reorder suggestions from sales speed (shared: label-stock-core.js) ---------------- */
async function sellerRenderSalesReorder(){
  const el = document.getElementById('sellerRoTable');
  if(!el || !currentUser) return;
  const days = parseInt(document.getElementById('sellerRoWindow').value, 10) || 30;
  const cover = parseInt(document.getElementById('sellerRoCover').value, 10) || 30;
  try{
    const used = await VLS.usagePerItem(currentUser.uid, 'stockMovements', 'productId', days);
    const rows = VLS.reorderRows(productsCache.map(p => ({ id: p.id, name: p.name, stock: p.stock || 0 })), used, days, cover);
    el.innerHTML = VLS.reorderTableHtml(rows, esc, cover);
  }catch(err){ console.error('Reorder suggestions failed:', err); el.innerHTML = '<tr><td colspan="7" style="color:var(--muted)">Could not load sales history.</td></tr>'; }
}

/* ---------------- Sell via Label (direct e-commerce sale → stock deduction) ----------------
   For a seller who ALSO sells directly on Amazon/Meesho/Flipkart (not just
   through buyers placing orders in this app): printing that sale's shipping
   label is the moment the unit leaves stock. This reuses the exact same PDF
   parsing the buyer side's label-order.html uses (label-sku-extract.js) and
   the exact same rawKey -> product mapping the CSV reconciliation above
   already builds (skuMappingsCache/`skuMappings`) — a SKU mapped once here
   is remembered for both this and the monthly reconciliation upload.
   Deliberately NOT an order: there's no buyer, no supplier, nothing to
   send — just an immediate stock-out through addStockMovement(), the same
   function every other stock change in this app already goes through. */
async function processSellerLabelFiles(){
  const input = document.getElementById('sellerLabelFiles');
  const files = input.files;
  if(!files || !files.length){ showMsg('sellerLabelMsg', 'Choose at least one label PDF.', false); return; }
  showMsg('sellerLabelMsg', 'Reading labels…', true);

  const hits = [];
  for(const file of files){
    try{
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      for(let i = 1; i <= pdf.numPages; i++){
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map(it => it.str).join(' ');
        const pageHits = extractAllMarketplaceItems(text);
        for(const hit of pageHits){
          hits.push({ ...hit, key: labelKey(hit.marketplace, hit.sku, text), packKey: packingKey(hit.marketplace, text) });
        }
      }
    }catch(err){
      showMsg('sellerLabelMsg', `Could not read ${file.name}: ${err.message}`, false);
      return;
    }
  }
  if(!hits.length){
    showMsg('sellerLabelMsg', 'No marketplace SKU could be detected in the uploaded file(s).', false);
    return;
  }
  await handleSellerLabelHits(hits, files.length);
}

/* Same rules as Label Cropper (billing/assets/label-stock-core.js):
   product once per product line per shipment; packing + one label sticker
   once per shipment (this page doesn't print, so the sticker is counted the
   first time the shipment is seen anywhere, same moment as packing).
   Unmapped SKUs go to the shared Unmapped Label SKUs list. */
async function handleSellerLabelHits(hits, fileCount){
  const uid = currentUser.uid;
  const userRef = db.collection('users').doc(uid);
  let deducted = 0, skipped = 0, packs = 0, stickers = 0;
  const unmapped = [];
  const results = [];
  const [pkgSnap, pszSnap, lszSnap] = await Promise.all([
    userRef.collection('buyerProductPackaging').get(),
    userRef.collection('buyerPackagingSizes').get(),
    userRef.collection('buyerLabelSizes').get()
  ]);
  const pkgs = pkgSnap.docs.map(d => d.data()).filter(d => d.sellerUid === uid);
  const sizeNames = {};
  pszSnap.docs.concat(lszSnap.docs).forEach(d => { sizeNames[d.id] = d.data().name || ''; });
  const packedThisRun = new Set();

  for(const hit of hits){
    const mapping = skuMappingsCache.find(m => String(m.rawKey||'').trim().toLowerCase() === hit.sku.trim().toLowerCase());
    const product = mapping ? productsCache.find(p => p.id === mapping.productId) : null;
    if(!product){
      unmapped.push(hit);
      results.push({ ...hit, productName: null, status: 'Unmapped' });
      continue;
    }
    const r = await VLS.sellerProductOnce(uid, hit, { id: product.id, name: product.name }, 'sell-via-label');
    if(r === 'already'){ skipped++; results.push({ ...hit, productName: product.name, status: 'Already' }); continue; }
    deducted++;
    results.push({ ...hit, productName: product.name, status: 'Deducted' });
    const pkg = pkgs.find(x => x.productId === product.id);
    if(pkg && !packedThisRun.has(hit.packKey)){
      packedThisRun.add(hit.packKey);
      const wasNew = !(await VLS.packingDone(uid, hit.packKey));
      if(wasNew){
        if(pkg.packagingSizeId && await VLS.packingOnce(uid, hit, pkg.packagingSizeId, sizeNames[pkg.packagingSizeId], `Sell via Label — ${hit.marketplace} ${hit.sku}`)) packs++;
        if(pkg.labelSizeId && await VLS.adjustSize(uid, 'buyerLabelSizes', pkg.labelSizeId, -1, { sizeName: sizeNames[pkg.labelSizeId], type: 'sell-via-label', note: `${hit.marketplace} ${hit.sku}` })) stickers++;
      }
    }
  }
  if(unmapped.length) await VLS.queueUnmapped(uid, unmapped, false, 'sell-via-label');

  document.getElementById('sellerLabelResultsTable').innerHTML = results.map(r => `
    <tr><td>${esc(r.marketplace)}</td><td>${esc(r.sku)}</td><td>${r.productName ? esc(r.productName) : '<span class="badge">Unmapped</span>'}</td><td>${r.qty}</td>
    <td>${r.status === 'Deducted' ? '<span style="color:#0E7C6B">Deducted</span>' : r.status === 'Already' ? '<span style="color:var(--muted)">Already counted</span>' : '<span style="color:var(--paprika-dark)">Map it in Unmapped Label SKUs above</span>'}</td></tr>
  `).join('');

  await loadProducts();
  await loadStockMovements();
  await loadLabelSkuQueue();
  const parts = [];
  if(deducted) parts.push(`${deducted} item(s) deducted from stock`);
  if(packs) parts.push(`${packs} packing`);
  if(stickers) parts.push(`${stickers} label(s)`);
  if(unmapped.length) parts.push(`${unmapped.length} unmapped — added to Unmapped Label SKUs above`);
  if(skipped) parts.push(`${skipped} already counted before`);
  showMsg('sellerLabelMsg', `Read ${fileCount} file(s) — ${parts.join(', ') || 'nothing new found'}.`, true);
  document.getElementById('sellerLabelFiles').value = '';
}

/* ---------------- Unmapped Label SKUs (queued by Label Cropper, Seller mode) ----------------
   Label Cropper (Seller) and Sell via Label write one doc per unmapped SKU
   to users/{uid}/sellerUnmappedLabelSkus, listing every label under
   `pending` with its shipment keys (key → product, packKey → packing) and
   labelDone (sticker already counted). Settling uses the shared rules in
   label-stock-core.js, so it can't double-count against either page. */
let labelSkuQueueCache = [];
async function loadLabelSkuQueue(){
  try{
    const snap = await db.collection('users').doc(currentUser.uid).collection('sellerUnmappedLabelSkus')
      .where('status', '==', 'UNMAPPED').get();
    labelSkuQueueCache = snap.docs.map(d => ({id: d.id, ...d.data()}))
      .sort((a,b) => String(b.lastSeen||'').localeCompare(String(a.lastSeen||'')));
  }catch(err){
    console.error('Loading unmapped label SKUs failed:', err);
    labelSkuQueueCache = [];
  }
  renderLabelSkuQueue();
}
function renderLabelSkuQueue(){
  const card = document.getElementById('labelSkuQueueCard');
  if(!card) return;
  // Alert banner at the top of every Billing page (#6).
  const banner = document.getElementById('sellerUnmappedBanner');
  if(banner){
    const n = labelSkuQueueCache.length;
    const labels = labelSkuQueueCache.reduce((a, q) => a + (q.labelCount || 0), 0);
    banner.classList.toggle('hidden', !n);
    document.getElementById('sellerUnmappedBannerCount').textContent = n ? `${n} SKU${n===1?' needs':'s need'} mapping (${labels} label${labels===1?'':'s'})` : '';
  }
  card.classList.toggle('hidden', !labelSkuQueueCache.length);
  document.getElementById('labelSkuQueueCount').textContent = labelSkuQueueCache.length || '';
  document.getElementById('labelSkuQueueTable').innerHTML = labelSkuQueueCache.map(q => {
    const known = skuMappingsCache.find(m => String(m.rawKey||'').trim().toLowerCase() === String(q.sku||'').trim().toLowerCase());
    // No mapping yet → pre-select the product whose SKUs look most like this one (shared suggestBySku()).
    const sug = known ? null : suggestBySku(q.sku, productsCache.map(p => ({ id: p.id, skus: skuMappingsCache.filter(m => m.productId === p.id).map(m => m.rawKey) })));
    const selId = known ? known.productId : (sug ? sug.id : '');
    const options = productsCache.map(p => `<option value="${p.id}"${p.id === selId ? ' selected' : ''}>${sug && p.id === selId ? '★ ' : ''}${esc(p.name)} (stock ${p.stock||0})</option>`).join('');
    return `<tr>
      <td>${esc((q.marketplaces || [q.marketplace]).join(', '))}</td>
      <td><code>${esc(q.sku)}</code></td>
      <td>${q.labelCount || 0}</td><td>${q.unitCount || 0}</td>
      <td style="white-space:nowrap">${esc(q.firstSeen||'')}${q.lastSeen && q.lastSeen !== q.firstSeen ? ' → ' + esc(q.lastSeen) : ''}</td>
      <td><select id="lsq-${q.id}"><option value="">Select product…</option>${options}</select>${sug ? ' <span class="badge" title="Pre-selected because its SKUs look like this one — check it, then Map & Deduct">★ suggested</span>' : ''}</td>
      <td class="row-actions">
        <button class="btn small primary" id="lsqBtn-${q.id}" onclick="mapQueuedLabelSku('${q.id}')">Map &amp; Deduct</button>
        <button class="btn small" onclick="dismissQueuedLabelSku('${q.id}')">Not a stock item</button>
      </td></tr>`;
  }).join('');
}
async function mapQueuedLabelSku(docId){
  const q = labelSkuQueueCache.find(x => x.id === docId);
  const productId = document.getElementById('lsq-' + docId).value;
  if(!q) return;
  if(!productId){ showMsg('labelSkuQueueMsg', `Pick a product for ${q.sku} first.`, false); return; }
  const product = productsCache.find(p => p.id === productId);
  if(!product) return;
  const btn = document.getElementById('lsqBtn-' + docId);
  if(btn) btn.disabled = true;
  showMsg('labelSkuQueueMsg', 'Saving mapping & deducting…', true);
  const uid = currentUser.uid;
  const userRef = db.collection('users').doc(uid);
  try{
    // 1) Save/replace the mapping (same skuMappings table as everything else).
    const key = String(q.sku).trim().toLowerCase();
    const existing = skuMappingsCache.find(m => String(m.rawKey||'').trim().toLowerCase() === key);
    if(existing){
      if(existing.productId !== productId) await userRef.collection('skuMappings').doc(existing.id).set({ rawKey: q.sku, productId, productName: product.name }, { merge: true });
    } else {
      await userRef.collection('skuMappings').add({ rawKey: q.sku, productId, productName: product.name, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
    }

    // 2) Deduct every label listed (shared rules — label-stock-core.js) and clear it.
    const [pkgSnap, pszSnap, lszSnap] = await Promise.all([
      userRef.collection('buyerProductPackaging').get(),
      userRef.collection('buyerPackagingSizes').get(),
      userRef.collection('buyerLabelSizes').get()
    ]);
    const pkgDoc = pkgSnap.docs.map(d => d.data()).find(d => d.sellerUid === uid && d.productId === productId) || null;
    const sizeNames = {};
    pszSnap.docs.concat(lszSnap.docs).forEach(d => { sizeNames[d.id] = d.data().name || ''; });
    const out = await VLS.settleQueued(uid, docId, { id: product.id, name: product.name }, pkgDoc, (col, id) => sizeNames[id] || '');
    const units = out.units, labels = out.labels, skipped = out.already, packing = out.packing, labelStickers = out.stickers;

    await loadProducts();
    await loadSkuMappings();
    await loadStockMovements();
    await loadLabelSkuQueue();
    const bits = [`${units} unit(s) deducted from ${product.name} for ${labels} label(s)`];
    if(packing) bits.push(`${packing} packing`);
    if(labelStickers) bits.push(`${labelStickers} label sticker(s)`);
    if(skipped) bits.push(`${skipped} label(s) were already deducted`);
    if(!pkgDoc) bits.push("no packing/label size picked for this product yet (Label Cropper → Seller Stock box), so none taken");
    else if(!packing && labels) bits.push('packing already counted for these shipments');
    showMsg('labelSkuQueueMsg', `Mapped ${q.sku} → ${product.name}. ${bits.join('; ')}.`, true);
  }catch(err){
    console.error('Map & deduct failed:', err);
    showMsg('labelSkuQueueMsg', 'Could not complete: ' + (err.code || err.message), false);
    if(btn) btn.disabled = false;
  }
}
async function dismissQueuedLabelSku(docId){
  const q = labelSkuQueueCache.find(x => x.id === docId);
  if(!q || !confirm(`Remove ${q.sku} from this list without deducting any stock?`)) return;
  await db.collection('users').doc(currentUser.uid).collection('sellerUnmappedLabelSkus').doc(docId).delete();
  await loadLabelSkuQueue();
  showMsg('labelSkuQueueMsg', `${q.sku} removed.`, true);
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
    <tr><td>${esc(c.legalName || '—')}</td><td>${esc(c.name)}</td><td>${esc(c.gstin||'—')}</td><td>${esc(c.state||'')}</td><td>${esc(c.email||'')}</td>
    <td>${c.linkStatus === 'ACTIVE' ? `<span class="badge">Linked · ${esc(c.linkedBuyerEmail||'')}</span>` : '<span style="color:var(--muted)">Not linked</span>'}</td>
    <td class="row-actions">
      <button class="btn small" onclick="goToCustomerDashboard('${c.id}')">Dashboard</button>
      <button class="btn small" onclick="editCustomer('${c.id}')">Edit</button>
      <button class="btn small danger" onclick="deleteCustomer('${c.id}')">Delete</button>
      ${c.linkStatus === 'ACTIVE'
        ? `<button class="btn small" onclick="unlinkBuyerAccount('${c.id}')">Unlink</button>`
        : `<button class="btn small" onclick="linkBuyerAccount('${c.id}')">Link Buyer</button>`}
    </td></tr>`).join('') || '<tr><td colspan="7" style="color:var(--muted)">No customers yet.</td></tr>';
}
async function saveCustomer(){
  const id = document.getElementById('cEditId').value;
  const stateCode = document.getElementById('cState').value;
  const data = {
    legalName: document.getElementById('cLegalName').value.trim(),
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
  if(id){ await col.doc(id).set(data, {merge:true}); } else { await col.add(data); }
  ['cLegalName','cName','cGstin','cAddress','cEmail','cPhone','cEditId'].forEach(f => document.getElementById(f).value = '');
  document.getElementById('cState').value = '';
  showMsg('customerMsg', 'Saved.', true);
  loadCustomers();
}
function editCustomer(id){
  const c = customersCache.find(x => x.id === id);
  document.getElementById('cEditId').value = id;
  document.getElementById('cLegalName').value = c.legalName || '';
  document.getElementById('cName').value = c.name;
  document.getElementById('cGstin').value = c.gstin || '';
  document.getElementById('cAddress').value = c.address || '';
  document.getElementById('cState').value = c.stateCode || '';
  document.getElementById('cEmail').value = c.email || '';
  document.getElementById('cPhone').value = c.phone || '';
}
async function deleteCustomer(id){
  if(!confirm('Delete this customer?')) return;
  const customer = customersCache.find(x => x.id === id);
  // A linked customer also has a sellerLinks row, which is what the BUYER's
  // "My Sellers" page actually reads — deleting only the customer doc used
  // to leave that row (and this seller) still showing on their side. Deletes
  // on sellerLinks are blocked by rules (by design, so a stray delete can't
  // wipe shared history), so this marks it removed instead — the buyer-side
  // queries already filter to status === 'ACTIVE', so a removed link simply
  // stops appearing for them.
  if(customer && customer.linkedBuyerUid){
    const linkId = `${currentUser.uid}_${customer.linkedBuyerUid}`;
    await db.collection('sellerLinks').doc(linkId).update({
      status: 'REMOVED_BY_SELLER',
      removedAt: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(err => console.error('Could not update sellerLinks on customer delete:', err));
  }
  await db.collection('users').doc(currentUser.uid).collection('customers').doc(id).delete();
  loadCustomers();
}

/* ---------------- Seller -> Buyer linking ----------------
   Works directly from the customer's row — no need to open Edit first (an
   earlier version required that, which was confusing and easy to trip:
   clicking Link Buyer without having clicked Edit first left the form's
   hidden cEditId empty, so the link silently failed with a "save the
   customer first" message even for an already-saved customer). Looks up
   buyerDirectory (a public uid<->email index a buyer creates for themselves
   when they turn on Buyer features in My Account) to find the buyer's uid,
   then records the relationship in two places:
     - on the customer doc itself (linkedBuyerUid/linkedBuyerEmail/linkStatus)
     - in a top-level sellerLinks/{sellerUid}_{buyerUid} doc, which is what
       Firestore security rules check to decide whether that buyer may read
       this seller's buyer-visible products. */
async function linkBuyerAccount(customerId){
  const customer = customersCache.find(c => c.id === customerId);
  if(!customer) return;
  const email = (window.prompt(`Buyer's login email for "${customer.name}" (the email they used to turn on Buyer Features):`, customer.linkedBuyerEmail || '') || '').trim().toLowerCase();
  if(!email) return;

  showMsg('buyerLinkMsg', 'Looking up buyer account…', true);
  try{
    const dirSnap = await db.collection('buyerDirectory').doc(email).get();
    if(!dirSnap.exists){
      showMsg('buyerLinkMsg', `No buyer account found for ${email}. Ask them to turn on "Buyer features" on their My Account page first (that's what creates this lookup entry), then try again — the email has to match exactly.`, false);
      return;
    }
    const buyerUid = dirSnap.data().uid;
    const linkId = `${currentUser.uid}_${buyerUid}`;
    await db.collection('users').doc(currentUser.uid).collection('customers').doc(customerId).set({
      linkedBuyerUid: buyerUid, linkedBuyerEmail: email, linkStatus: 'ACTIVE'
    }, {merge:true});
    await db.collection('sellerLinks').doc(linkId).set({
      sellerUid: currentUser.uid,
      sellerName: businessData.businessName || currentUser.email,
      sellerEmail: currentUser.email || '',
      buyerUid, buyerEmail: email,
      customerId: customerId,
      status: 'ACTIVE',
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, {merge:true});
    showMsg('buyerLinkMsg', `Linked. ${email} can now see any of your products marked Active + Buyer Visible.`, true);
    loadCustomers();
  }catch(err){
    showMsg('buyerLinkMsg', err.message, false);
  }
}
async function unlinkBuyerAccount(customerId){
  const customer = customersCache.find(c => c.id === customerId);
  if(!customer || !customer.linkedBuyerUid){ showMsg('buyerLinkMsg', 'This customer is not linked to a buyer account.', false); return; }
  if(!confirm(`Unlink ${customer.linkedBuyerEmail || 'this buyer'} from ${customer.name}?`)) return;
  const linkId = `${currentUser.uid}_${customer.linkedBuyerUid}`;
  await db.collection('users').doc(currentUser.uid).collection('customers').doc(customerId).set({linkStatus: 'INACTIVE'}, {merge:true});
  await db.collection('sellerLinks').doc(linkId).set({status: 'INACTIVE', updatedAt: firebase.firestore.FieldValue.serverTimestamp()}, {merge:true});
  showMsg('buyerLinkMsg', 'Unlinked. This customer can no longer see your buyer-visible products.', true);
  loadCustomers();
}
function renderCustomerDropdown(){
  const sel = document.getElementById('invCustomer');
  sel.innerHTML = '<option value="">Select customer…</option>' +
    customersCache.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
}

/* ---------------- Suppliers (purchase side, separate master from Customers) ---------------- */
async function loadSuppliers(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('suppliers').orderBy('name').get();
  suppliersCache = snap.docs.map(d => ({id:d.id, ...d.data()}));
  renderSuppliers();
  renderSupplierDropdown();
  renderPayablesOverview();
}
function renderSuppliers(){
  document.getElementById('suppliersTable').innerHTML = suppliersCache.map(s => `
    <tr><td>${esc(s.legalName || '—')}</td><td>${esc(s.name)}</td><td>${esc(s.gstin||'—')}</td><td>${esc(s.state||'')}</td><td>${esc(s.phone||'')}</td>
    <td class="row-actions">
      <button class="btn small" onclick="openSupplierLedger('${s.id}')">Ledger</button>
      <button class="btn small" onclick="editSupplier('${s.id}')">Edit</button>
      <button class="btn small danger" onclick="deleteSupplier('${s.id}')">Delete</button>
    </td></tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">No suppliers yet.</td></tr>';
}
async function saveSupplier(){
  const id = document.getElementById('sEditId').value;
  const stateCode = document.getElementById('sState').value;
  const data = {
    legalName: document.getElementById('sLegalName').value.trim(),
    name: document.getElementById('sName').value.trim(),
    gstin: document.getElementById('sGstin').value.trim(),
    address: document.getElementById('sAddress').value.trim(),
    stateCode: stateCode,
    state: stateNameByCode(stateCode),
    email: document.getElementById('sEmail').value.trim(),
    phone: document.getElementById('sPhone').value.trim()
  };
  if(!data.name){ showMsg('supplierMsg', 'Supplier name is required.', false); return; }
  const col = db.collection('users').doc(currentUser.uid).collection('suppliers');
  if(id){ await col.doc(id).set(data); } else { await col.add(data); }
  ['sLegalName','sName','sGstin','sAddress','sEmail','sPhone','sEditId'].forEach(f => document.getElementById(f).value = '');
  document.getElementById('sState').value = '';
  showMsg('supplierMsg', 'Saved.', true);
  loadSuppliers();
}
function editSupplier(id){
  const s = suppliersCache.find(x => x.id === id);
  document.getElementById('sEditId').value = id;
  document.getElementById('sLegalName').value = s.legalName || '';
  document.getElementById('sName').value = s.name;
  document.getElementById('sGstin').value = s.gstin || '';
  document.getElementById('sAddress').value = s.address || '';
  document.getElementById('sState').value = s.stateCode || '';
  document.getElementById('sEmail').value = s.email || '';
  document.getElementById('sPhone').value = s.phone || '';
}
async function deleteSupplier(id){
  if(!confirm('Delete this supplier? Their past purchase and payment records are kept.')) return;
  await db.collection('users').doc(currentUser.uid).collection('suppliers').doc(id).delete();
  loadSuppliers();
}
function renderSupplierDropdown(){
  ['purSupplier','dashSupplier','payEntrySupplier'].forEach(id => {
    const sel = document.getElementById(id);
    if(!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">Select supplier…</option>' +
      suppliersCache.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    if(prev && suppliersCache.some(s => s.id === prev)) sel.value = prev;
  });
}

/* ---------------- Purchase Product Master (separate from the GST billing Products list — purchase price differs from selling price) ---------------- */
/* Finds a sellable Product whose name matches a Purchase Product's name,
   case-insensitively and ignoring surrounding whitespace. Used to auto-link
   the two lists by name instead of requiring a manual dropdown pick. */
function findProductByName(name){
  const norm = (name || '').trim().toLowerCase();
  if(!norm) return null;
  return productsCache.find(p => (p.name || '').trim().toLowerCase() === norm) || null;
}
/* Backfills linkedProductId for any Purchase Product that isn't linked yet,
   or whose link points to a Product that's since been deleted, by matching
   names against the sellable Products list. Runs every time Purchase
   Products load, so a purchase product and its matching sellable product
   get linked automatically whichever one was created first. */
async function autoLinkPurchaseProducts(){
  const col = db.collection('users').doc(currentUser.uid).collection('purchaseProducts');
  for(const pp of purchaseProductsCache){
    const stillValid = pp.linkedProductId && productsCache.some(p => p.id === pp.linkedProductId);
    if(stillValid) continue;
    const match = findProductByName(pp.name);
    if(match){
      pp.linkedProductId = match.id;
      await col.doc(pp.id).update({ linkedProductId: match.id });
    }
  }
}
async function loadPurchaseProducts(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('purchaseProducts').orderBy('name').get();
  purchaseProductsCache = snap.docs.map(d => ({id:d.id, ...d.data()}));
  await autoLinkPurchaseProducts();
  renderPurchaseProducts();
  renderPurchaseProductDropdowns();
}
function renderPurchaseProducts(){
  document.getElementById('purchaseProductsTable').innerHTML = purchaseProductsCache.map(p => {
    const linked = p.linkedProductId ? productsCache.find(x => x.id === p.linkedProductId) : null;
    return `<tr><td>${esc(p.name)}</td><td>${esc(p.hsn || '—')}</td><td>${esc(p.unit)}</td><td>${linked ? esc(linked.name) : '—'}</td>
    <td class="row-actions">
      <button class="btn small" onclick="editPurchaseProduct('${p.id}')">Edit</button>
      <button class="btn small danger" onclick="deletePurchaseProduct('${p.id}')">Delete</button>
    </td></tr>`;
  }).join('') || '<tr><td colspan="5" style="color:var(--muted)">No purchase products yet.</td></tr>';
}
async function savePurchaseProduct(){
  const id = document.getElementById('ppEditId').value;
  const name = document.getElementById('ppName').value.trim();
  // Auto-link by name when the user hasn't manually picked a linked product:
  // if a sellable Product with the same name (case/whitespace-insensitive)
  // exists, connect them automatically so stock updates without extra steps.
  let linkedProductId = document.getElementById('ppLinkedProduct').value || null;
  if(!linkedProductId){
    const match = findProductByName(name);
    if(match) linkedProductId = match.id;
  }
  const data = {
    name,
    hsn: document.getElementById('ppHsn').value.trim(),
    unit: document.getElementById('ppUnit').value.trim() || 'PCS',
    linkedProductId
  };
  if(!data.name){ showMsg('purchaseProductMsg', 'Product name is required.', false); return; }
  const col = db.collection('users').doc(currentUser.uid).collection('purchaseProducts');
  if(id){ await col.doc(id).set(data); } else { await col.add(data); }
  ['ppName','ppHsn','ppUnit','ppEditId'].forEach(f => document.getElementById(f).value = '');
  document.getElementById('ppLinkedProduct').value = '';
  showMsg('purchaseProductMsg', 'Saved.', true);
  loadPurchaseProducts();
}
function editPurchaseProduct(id){
  const p = purchaseProductsCache.find(x => x.id === id);
  document.getElementById('ppEditId').value = id;
  document.getElementById('ppName').value = p.name;
  document.getElementById('ppHsn').value = p.hsn || '';
  document.getElementById('ppUnit').value = p.unit;
  document.getElementById('ppLinkedProduct').value = p.linkedProductId || '';
}
async function deletePurchaseProduct(id){
  if(!confirm('Delete this purchase product?')) return;
  await db.collection('users').doc(currentUser.uid).collection('purchaseProducts').doc(id).delete();
  loadPurchaseProducts();
}
function renderPurchaseProductDropdowns(){
  document.querySelectorAll('.pur-line-product').forEach(sel => fillPurchaseProductOptions(sel));
}
function fillPurchaseProductOptions(sel){
  sel.innerHTML = '<option value="">Select product…</option>' +
    purchaseProductsCache.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
}

/* Looks through past purchases for the most recent price paid to a specific
   supplier for a specific product. purchasesCache is already ordered newest
   date first (see loadPurchases), so the first match found is the latest. */
function getLastPriceForSupplierProduct(supplierId, productId){
  for(const p of purchasesCache){
    if(p.supplierId !== supplierId) continue;
    for(const li of (p.items||[])){
      if(li.productId === productId) return { rate: li.rate, gstRate: li.gstRate, priceMode: li.priceMode || 'incl', date: p.date };
    }
  }
  return null;
}

/* Total purchased minus total paid, across every purchase/payment on record for this supplier. */
function getSupplierBalance(supplierId){
  const totalPurchase = purchasesCache.filter(p => p.supplierId === supplierId).reduce((s,p) => s + (p.grandTotal||0), 0);
  const totalPaid = paymentsCache.filter(p => p.supplierId === supplierId).reduce((s,p) => s + (p.amount||0), 0);
  return totalPurchase - totalPaid;
}

/* ---------------- Receivables — money owed BY customers (mirror of the Payables/Supplier system above) ----------------
   Invoices are the "Dr" side (what's billed), receipts are the "Cr" side
   (what's actually been received) — exactly the same shape as
   purchases/payments, just the other direction of money. */
let receiptsCache = [];
function invoicesArray(){
  // invoicesCache is keyed by id (used elsewhere for O(1) lookup by
  // invoice id) — this just gives the array view Receivables needs.
  return Object.keys(invoicesCache).map(id => ({ id, ...invoicesCache[id] })).filter(inv => !inv.deleted);
}
// Matches an invoice to a customer: by customerId when the invoice has one
// (everything billed from here on), falling back to name+GSTIN for
// invoices saved before this field existed.
function invoiceBelongsToCustomer(inv, customer){
  if(inv.customerId) return inv.customerId === customer.id;
  return inv.customer && inv.customer.name === customer.name && (inv.customer.gstin||'') === (customer.gstin||'');
}
function getCustomerBalance(customerId){
  const customer = customersCache.find(c => c.id === customerId);
  if(!customer) return 0;
  const totalBilled = invoicesArray().filter(inv => invoiceBelongsToCustomer(inv, customer)).reduce((s,inv) => s + (inv.grandTotal||0), 0);
  const totalReceived = receiptsCache.filter(r => r.customerId === customerId).reduce((s,r) => s + (r.amount||0), 0);
  return totalBilled - totalReceived;
}
async function loadReceipts(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('receipts').orderBy('date','desc').get();
  receiptsCache = snap.docs.map(d => ({id:d.id, ...d.data()})).filter(r => !r.deleted);
  populateReceiptCustomerDropdowns();
  renderReceiptsTable();
  refreshOpenCustomerDashboard();
}

/* ---------------- Payment Confirmations (a buyer says they paid you directly) ----------------
   The buyer's own Payment Entry writes this shared doc when they pay a
   supplier that's a linked VISUTRA seller — since paying someone doesn't
   mean it actually reached them, the seller confirms before it becomes a
   real Receipt. Neither side can write to the other's data, so this shared
   doc is the coordination point: the seller approves/rejects it here, and
   the buyer's own client finalizes their own side once it sees the result
   (see billing/buyer/payment-entry.html's own sweep). */
async function loadPaymentConfirmations(){
  const snap = await db.collection('paymentConfirmations')
    .where('sellerUid', '==', currentUser.uid).where('status', '==', 'PENDING').get();
  const requests = snap.docs.map(d => ({id: d.id, ...d.data()}));
  const card = document.getElementById('paymentConfirmCard');
  if(!card) return;
  if(!requests.length){ card.classList.add('hidden'); return; }
  card.classList.remove('hidden');
  document.getElementById('paymentConfirmTable').innerHTML = requests.map(r => `
    <tr><td>${esc(r.buyerName||r.buyerEmail||'Buyer')}</td><td>${esc(r.date)}</td><td>₹${fmtMoney(r.amount)}</td><td>${esc(r.mode||'—')}</td><td>${esc(r.note||'')}</td>
    <td class="row-actions">
      <button class="btn small primary" onclick="respondToPaymentConfirmation('${r.id}', true)">Approve</button>
      <button class="btn small danger" onclick="respondToPaymentConfirmation('${r.id}', false)">Reject</button>
    </td></tr>`).join('');
}
// Finds this buyer's linked Customer record, or creates one if the seller
// never ran Link Buyer for them — same idea as ensureSupplierForSeller on
// the buyer's side, just the other direction, so a receipt always has
// somewhere correct to attach to.
async function ensureCustomerForBuyer(buyerUid, buyerName, buyerEmail){
  const existing = customersCache.find(c => c.linkedBuyerUid === buyerUid);
  if(existing) return existing.id;
  const ref = await db.collection('users').doc(currentUser.uid).collection('customers').add({
    name: buyerName || buyerEmail || 'Buyer', gstin: '', address: '', stateCode: '', state: '',
    email: buyerEmail || '', phone: '',
    linkedBuyerUid: buyerUid, linkedBuyerEmail: buyerEmail || '', linkStatus: 'ACTIVE',
    autoCreatedFromPayment: true
  });
  return ref.id;
}
async function respondToPaymentConfirmation(confirmId, approve){
  const confirmMsg = approve
    ? 'Approve this payment? It will be added to your Receipts and reflected in the buyer\'s own Payment History.'
    : 'Reject this payment? The buyer will see it was declined and their pending record is removed.';
  if(!confirm(confirmMsg)) return;

  try{
    const reqSnap = await db.collection('paymentConfirmations').doc(confirmId).get();
    if(!reqSnap.exists){ alert('This request no longer exists.'); await loadPaymentConfirmations(); return; }
    const req = reqSnap.data();
    if(req.status !== 'PENDING'){ alert('This request has already been responded to.'); await loadPaymentConfirmations(); return; }

    if(approve){
      const customerId = await ensureCustomerForBuyer(req.buyerUid, req.buyerName, req.buyerEmail);
      await loadCustomers(); // pick up a possibly-just-created customer before crediting it
      const customer = customersCache.find(c => c.id === customerId);
      await db.collection('users').doc(currentUser.uid).collection('receipts').add({
        customerId, customerName: customer ? customer.name : (req.buyerName || 'Buyer'),
        date: req.date, amount: req.amount, mode: req.mode || '', note: req.note || 'Paid directly (confirmed)',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await loadReceipts();
    }

    await db.collection('paymentConfirmations').doc(confirmId).update({
      status: approve ? 'APPROVED' : 'REJECTED',
      respondedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await loadPaymentConfirmations();
  }catch(err){
    alert(`Could not respond: ${err.message}`);
  }
}
function populateReceiptCustomerDropdowns(){
  const options = '<option value="">Select customer…</option>' +
    customersCache.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  ['receiptCustomer','custDashCustomer'].forEach(id => {
    const sel = document.getElementById(id);
    if(!sel) return;
    const prev = sel.value;
    sel.innerHTML = options;
    if(prev) sel.value = prev;
  });
}
async function saveReceipt(){
  const customerId = document.getElementById('receiptCustomer').value;
  const customer = customersCache.find(c => c.id === customerId);
  if(!customer){ showMsg('receiptMsg', 'Select a customer first.', false); return; }
  const amount = parseFloat(document.getElementById('receiptAmount').value) || 0;
  if(amount <= 0){ showMsg('receiptMsg', 'Enter a receipt amount greater than zero.', false); return; }
  const dateVal = document.getElementById('receiptDate').value || new Date().toISOString().slice(0,10);
  const mode = document.getElementById('receiptMode').value.trim();
  const note = document.getElementById('receiptNote').value.trim();
  const editId = document.getElementById('receiptEditId').value;

  const data = { customerId, customerName: customer.name, date: dateVal, amount, mode, note };
  if(editId){
    await db.collection('users').doc(currentUser.uid).collection('receipts').doc(editId).set(data, {merge:true});
  } else {
    data.createdAt = firebase.firestore.FieldValue.serverTimestamp();
    await db.collection('users').doc(currentUser.uid).collection('receipts').add(data);
  }
  await loadReceipts();

  cancelEditReceipt();
  showMsg('receiptMsg', editId
    ? `Receipt updated. Balance now ₹${fmtMoney(getCustomerBalance(customerId))}.`
    : `Receipt of ₹${fmtMoney(amount)} recorded for ${customer.name}. Balance now ₹${fmtMoney(getCustomerBalance(customerId))}.`, true);
}
function editReceipt(id){
  const r = receiptsCache.find(x => x.id === id);
  if(!r) return;
  document.getElementById('receiptEditId').value = id;
  document.getElementById('receiptCustomer').value = r.customerId;
  document.getElementById('receiptDate').value = r.date;
  document.getElementById('receiptAmount').value = r.amount;
  updateAmountWords('receiptAmount','receiptAmountWords');
  document.getElementById('receiptMode').value = r.mode || '';
  document.getElementById('receiptNote').value = r.note || '';
  document.getElementById('receiptFormTitle').textContent = 'Edit Receipt';
  document.getElementById('receiptCancelEditBtn').classList.remove('hidden');
}
function cancelEditReceipt(){
  document.getElementById('receiptEditId').value = '';
  document.getElementById('receiptCustomer').value = '';
  ['receiptAmount','receiptMode','receiptNote'].forEach(f => document.getElementById(f).value = '');
  updateAmountWords('receiptAmount','receiptAmountWords');
  document.getElementById('receiptFormTitle').textContent = 'Receipt Entry';
  document.getElementById('receiptCancelEditBtn').classList.add('hidden');
}
async function deleteReceipt(id){
  if(!confirm('Move this receipt to the Recycle Bin? You can restore it within 30 days.')) return;
  await db.collection('users').doc(currentUser.uid).collection('receipts').doc(id).update({
    deleted: true, deletedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await loadReceipts();
}
function renderReceiptsTable(){
  const tbody = document.getElementById('receiptsEntryTable');
  if(!tbody) return;
  tbody.innerHTML = receiptsCache.filter(r => dateInRange(r.date, 'receiptHistFrom', 'receiptHistTo')).map(r => `
    <tr>
      <td>${esc(r.date)}</td>
      <td><a href="#" onclick="goToCustomerDashboard('${r.customerId}');return false;">${esc(r.customerName)}</a></td>
      <td>₹${fmtMoney(r.amount)}</td>
      <td>${esc(r.mode||'—')}</td>
      <td>${esc(r.note||'')}</td>
      <td class="row-actions"><button class="btn small" onclick="editReceipt('${r.id}')">Edit</button><button class="btn small danger" onclick="deleteReceipt('${r.id}')">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">No receipts recorded yet.</td></tr>';
}
function renderReceivablesOverview(){
  const tbody = document.getElementById('receivablesTable');
  if(!tbody) return;
  const invoices = invoicesArray();
  const rows = customersCache.map(c => {
    const totalBilled = invoices.filter(inv => invoiceBelongsToCustomer(inv, c)).reduce((s,inv) => s + (inv.grandTotal||0), 0);
    const totalReceived = receiptsCache.filter(r => r.customerId === c.id).reduce((s,r) => s + (r.amount||0), 0);
    return { id: c.id, name: c.name, totalBilled, totalReceived, balance: totalBilled - totalReceived };
  }).filter(r => r.totalBilled > 0 || r.totalReceived > 0)
    .sort((a,b) => b.balance - a.balance);
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><a href="#" onclick="goToCustomerDashboard('${r.id}');return false;">${esc(r.name)}</a></td>
      <td>₹${fmtMoney(r.totalBilled)}</td>
      <td>₹${fmtMoney(r.totalReceived)}</td>
      <td>₹${fmtMoney(r.balance)}</td>
      <td class="row-actions"><button class="btn small" onclick="goToCustomerDashboard('${r.id}')">View</button></td>
    </tr>`).join('') || '<tr><td colspan="5" style="color:var(--muted)">No customer activity yet.</td></tr>';
}
function renderCustomerDashboard(customerId){
  const wrap = document.getElementById('custDashSummaryWrap');
  const emptyMsg = document.getElementById('custDashEmptyMsg');
  if(!customerId){ wrap.classList.add('hidden'); emptyMsg.classList.add('hidden'); return; }

  const customer = customersCache.find(c => c.id === customerId);
  if(!customer){ wrap.classList.add('hidden'); emptyMsg.classList.add('hidden'); return; }

  const invoices = invoicesArray().filter(inv => invoiceBelongsToCustomer(inv, customer)).sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const receipts = receiptsCache.filter(r => r.customerId === customerId);

  if(!invoices.length && !receipts.length){
    wrap.classList.add('hidden');
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');
  wrap.classList.remove('hidden');

  let totalItems = 0;
  const rows = [];
  invoices.forEach(inv => (inv.items||[]).filter(li => li.productId).forEach(li => {
    totalItems += (li.qty||0);
    rows.push({ date: inv.date, type:'invoice', desc:`${li.name} — Invoice ${inv.invoiceNo}`, qty:`${li.qty} ${li.unit||''}`, debit: li.total || (li.taxable + (li.taxable*(li.gstRate||0)/100)), credit:0, invoiceId: inv.id });
  }));
  receipts.forEach(r => {
    const label = r.note ? `Receipt (${r.mode || '—'}) — ${r.note}` : `Receipt (${r.mode || '—'})`;
    rows.push({ date:r.date, type:'receipt', desc:label, qty:'', debit:0, credit:r.amount, receiptId:r.id });
  });
  rows.sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  let totalBilled = 0, totalReceived = 0, running = 0;
  document.getElementById('custDashTable').innerHTML = rows.map(r => {
    running += r.debit - r.credit;
    totalBilled += r.debit; totalReceived += r.credit;
    const actions = r.invoiceId
      ? `<a class="btn small" href="invoice-view.html?id=${r.invoiceId}" target="_blank">View Invoice</a>`
      : `<button class="btn small" onclick="editReceipt('${r.receiptId}')">Edit</button><button class="btn small danger" onclick="deleteReceipt('${r.receiptId}')">Delete</button>`;
    return `<tr>
      <td>${esc(r.date)}</td>
      <td><span class="badge">${r.type === 'invoice' ? 'Invoice' : 'Receipt'}</span></td>
      <td>${esc(r.desc)}</td>
      <td>${esc(r.qty)}</td>
      <td>${r.debit ? '₹'+fmtMoney(r.debit) : ''}</td>
      <td>${r.credit ? '₹'+fmtMoney(r.credit) : ''}</td>
      <td>₹${fmtMoney(running)}</td>
      <td class="row-actions">${actions}</td>
    </tr>`;
  }).join('');

  document.getElementById('custDashEntries').textContent = invoices.length;
  document.getElementById('custDashItems').textContent = totalItems;
  document.getElementById('custDashTotalBilled').textContent = '₹' + fmtMoney(totalBilled);
  document.getElementById('custDashTotalReceived').textContent = '₹' + fmtMoney(totalReceived);
  document.getElementById('custDashBalance').textContent = '₹' + fmtMoney(totalBilled - totalReceived);
  document.getElementById('custDashLastInvoice').textContent = invoices.length ? `${invoices[invoices.length-1].date} — ₹${fmtMoney(invoices[invoices.length-1].grandTotal)}` : '—';
}
function refreshOpenCustomerDashboard(){
  const sel = document.getElementById('custDashCustomer');
  if(sel && sel.value) renderCustomerDashboard(sel.value);
  renderReceivablesOverview();
}
function goToCustomerDashboard(customerId){
  activateView('customer-dashboard');
  const sel = document.getElementById('custDashCustomer');
  if(sel){ sel.value = customerId; renderCustomerDashboard(customerId); }
}

/* ---------------- Supplier Dashboard (pick a supplier, see everything at a glance) ---------------- */
function renderSupplierDashboard(supplierId){
  const wrap = document.getElementById('dashSummaryWrap');
  const emptyMsg = document.getElementById('dashEmptyMsg');
  if(!supplierId){ wrap.classList.add('hidden'); emptyMsg.classList.add('hidden'); return; }

  const purchases = purchasesCache.filter(p => p.supplierId === supplierId); // newest first
  const payments = paymentsCache.filter(p => p.supplierId === supplierId);

  if(!purchases.length && !payments.length){
    wrap.classList.add('hidden');
    emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg.classList.add('hidden');
  wrap.classList.remove('hidden');

  let totalItems = 0;
  const rows = [];
  purchases.forEach(p => (p.items||[]).forEach(li => {
    totalItems += (li.qty||0);
    rows.push({ date:p.date, type:'purchase', desc:`${li.name} @ ₹${fmtMoney(li.rate)} ${li.priceMode==='excl' ? 'excl. GST' : 'incl. GST'} (${li.gstRate}% GST)`, qty:`${li.qty} ${li.unit}`, debit:li.total, credit:0, purchaseId:p.id });
  }));
  payments.forEach(pay => {
    const label = pay.note ? `Payment (${pay.mode || '—'}) — ${pay.note}` : `Payment (${pay.mode || '—'})`;
    rows.push({ date:pay.date, type:'payment', desc:label, qty:'', debit:0, credit:pay.amount, paymentId:pay.id });
  });
  rows.sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  let totalPurchase = 0, totalPaid = 0, running = 0;
  document.getElementById('dashTable').innerHTML = rows.map(r => {
    running += r.debit - r.credit;
    totalPurchase += r.debit; totalPaid += r.credit;
    const actions = r.purchaseId
      ? `<button class="btn small" onclick="editPurchase('${r.purchaseId}')">Edit</button>`
      : `<button class="btn small" onclick="editPayment('${r.paymentId}')">Edit</button><button class="btn small danger" onclick="deletePayment('${r.paymentId}')">Delete</button>`;
    return `<tr>
      <td>${esc(r.date)}</td>
      <td><span class="badge">${r.type === 'purchase' ? 'Purchase' : 'Payment'}</span></td>
      <td>${esc(r.desc)}</td>
      <td>${esc(r.qty)}</td>
      <td>${r.debit ? '₹'+fmtMoney(r.debit) : ''}</td>
      <td>${r.credit ? '₹'+fmtMoney(r.credit) : ''}</td>
      <td>₹${fmtMoney(running)}</td>
      <td class="row-actions">${actions}</td>
    </tr>`;
  }).join('');

  document.getElementById('dashEntries').textContent = purchases.length;
  document.getElementById('dashItems').textContent = totalItems;
  document.getElementById('dashTotalPurchase').textContent = '₹' + fmtMoney(totalPurchase);
  document.getElementById('dashTotalPaid').textContent = '₹' + fmtMoney(totalPaid);
  document.getElementById('dashBalance').textContent = '₹' + fmtMoney(totalPurchase - totalPaid);
  document.getElementById('dashLastPurchase').textContent = purchases.length ? `${purchases[0].date} — ₹${fmtMoney(purchases[0].grandTotal)}` : '—';
}
function refreshOpenDashboard(){
  const sel = document.getElementById('dashSupplier');
  if(sel && sel.value) renderSupplierDashboard(sel.value);
  renderPayablesOverview();
}
function renderPayablesOverview(){
  const tbody = document.getElementById('payablesTable');
  if(!tbody) return;
  const rows = suppliersCache.map(s => {
    const totalPurchase = purchasesCache.filter(p => p.supplierId === s.id).reduce((sum,p) => sum + (p.grandTotal||0), 0);
    const totalPaid = paymentsCache.filter(p => p.supplierId === s.id).reduce((sum,p) => sum + (p.amount||0), 0);
    return { id: s.id, name: s.name, totalPurchase, totalPaid, balance: totalPurchase - totalPaid };
  }).filter(r => r.totalPurchase > 0 || r.totalPaid > 0)
    .sort((a,b) => b.balance - a.balance);
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><a href="#" onclick="goToSupplierDashboard('${r.id}');return false;">${esc(r.name)}</a></td>
      <td>₹${fmtMoney(r.totalPurchase)}</td>
      <td>₹${fmtMoney(r.totalPaid)}</td>
      <td>₹${fmtMoney(r.balance)}</td>
      <td class="row-actions"><button class="btn small" onclick="goToSupplierDashboard('${r.id}')">View</button></td>
    </tr>`).join('') || '<tr><td colspan="5" style="color:var(--muted)">No supplier activity yet.</td></tr>';
}

/* ---------------- Purchase-side GST data used by GSTR-1 Filing (see below) ----------------
   Filters Purchases into the same rate-wise shape the Sales side uses, for
   the same period — this is what you bought (from suppliers, or auto-created
   from an accepted buyer order), not what you sold. */
let gstr1PurchaseRows = [];
function computePurchaseGstrRows(start, end){
  return purchasesCache.filter(p => {
    const d = parseLocalDate(p.date);
    return d >= start && d < end;
  }).map(p => {
    const supplier = suppliersCache.find(s => s.id === p.supplierId);
    return {
      id: p.id, date: p.date, supplierName: p.supplierName || (supplier && supplier.name) || 'Unknown',
      gstin: (supplier && supplier.gstin) || '',
      taxable: p.subtotal || 0, gst: p.gstTotal || 0, total: p.grandTotal || 0, items: p.items || []
    };
  });
}
function renderPurchaseGstrSection(){
  let taxable = 0, gst = 0, grand = 0;
  const byRate = {};
  gstr1PurchaseRows.forEach(r => {
    taxable += r.taxable; gst += r.gst; grand += r.total;
    r.items.forEach(li => {
      const rate = li.gstRate || 0;
      if(!byRate[rate]) byRate[rate] = { taxable: 0, gst: 0 };
      byRate[rate].taxable += li.taxable || 0;
      byRate[rate].gst += li.gstAmt || 0;
    });
  });
  document.getElementById('pgTaxable').textContent = fmtMoney(taxable);
  document.getElementById('pgGst').textContent = fmtMoney(gst);
  document.getElementById('pgGrand').textContent = fmtMoney(grand);
  const rates = Object.keys(byRate).map(Number).sort((a,b) => a-b);
  document.getElementById('pgRateTable').innerHTML = rates.map(r => `
    <tr><td>${r}%</td><td>${fmtMoney(byRate[r].taxable)}</td><td>${fmtMoney(byRate[r].gst)}</td><td>${fmtMoney(byRate[r].taxable + byRate[r].gst)}</td></tr>
  `).join('');
  document.getElementById('pgEmptyMsg').classList.toggle('hidden', gstr1PurchaseRows.length > 0);

  document.getElementById('pgRegisterTable').innerHTML = gstr1PurchaseRows.map(r => `
    <tr><td>${esc(r.date)}</td><td>${esc(r.supplierName)}</td><td>${esc(r.gstin || '—')}</td>
    <td>${fmtMoney(r.taxable)}</td><td>${fmtMoney(r.gst)}</td><td>${fmtMoney(r.total)}</td></tr>
  `).join('') || '<tr><td colspan="6" style="color:var(--muted)">No purchases this period.</td></tr>';

  // Item-level view: one row per product per purchase, so qty/HSN/rate are
  // visible per line rather than only the per-purchase total above. Falls
  // back to the Purchase Product's CURRENT hsn when the saved line item has
  // none — purchases recorded before HSN was added to Purchase Products (or
  // before it was filled in for that product) won't have it baked into the
  // old record, but this still shows it correctly once it's set, with no
  // need to re-save every old purchase by hand.
  const itemRows = [];
  gstr1PurchaseRows.forEach(r => {
    r.items.forEach(li => {
      const currentHsn = (purchaseProductsCache.find(p => p.id === li.productId) || {}).hsn || '';
      itemRows.push({ date: r.date, supplierName: r.supplierName, name: li.name, hsn: li.hsn || currentHsn, qty: li.qty, unit: li.unit, gstRate: li.gstRate || 0, taxable: li.taxable || 0, gstAmt: li.gstAmt || 0, total: li.total || 0 });
    });
  });
  document.getElementById('pgItemsTable').innerHTML = itemRows.map(r => `
    <tr><td>${esc(r.date)}</td><td>${esc(r.supplierName)}</td><td>${esc(r.name)}</td><td>${esc(r.hsn || '—')}</td>
    <td>${r.qty} ${esc(r.unit||'')}</td><td>${r.gstRate}%</td><td>${fmtMoney(r.taxable)}</td><td>${fmtMoney(r.gstAmt)}</td><td>${fmtMoney(r.total)}</td></tr>
  `).join('') || '<tr><td colspan="9" style="color:var(--muted)">No purchase line items this period.</td></tr>';
}

/* ---------------- Purchases (line items pick from the Purchase Product master above, not the billing Products list) ---------------- */
function addPurchaseLineItem(){
  purchaseLineItems.push({productId:'', name:'', unit:'PCS', qty:1, rate:0, gstRate:0, priceMode:'incl'});
  renderPurchaseLineItems();
}
function removePurchaseLineItem(idx){
  purchaseLineItems.splice(idx, 1);
  renderPurchaseLineItems();
}
/* Purchase line items can take the unit price either INCLUDING or EXCLUDING
   GST, picked per line via the Price Type dropdown — since some suppliers
   quote inclusive and others exclusive, even within the same purchase. */
function purchaseLineCalc(li){
  const gstRate = li.gstRate || 0;
  const qty = li.qty || 0, rate = li.rate || 0;
  if(li.priceMode === 'excl'){
    const taxable = qty * rate;
    const gstAmt = taxable * gstRate / 100;
    return { taxable, gstAmt, total: taxable + gstAmt };
  }
  const total = qty * rate; // incl. GST (default): qty × rate is already the line total incl. GST
  const taxable = gstRate ? total / (1 + gstRate/100) : total;
  return { taxable, gstAmt: total - taxable, total };
}
function renderPurchaseLineItems(){
  const tbody = document.getElementById('purchaseLineItemsTable');
  tbody.innerHTML = purchaseLineItems.map((li, i) => {
    const { taxable, gstAmt, total } = purchaseLineCalc(li);
    const mode = li.priceMode === 'excl' ? 'excl' : 'incl';
    return `<tr>
      <td><select class="pur-line-product" onchange="onPurchaseProductPick(${i}, this.value)"></select></td>
      <td><input type="number" min="0" step="1" value="${li.qty}" style="width:60px" onchange="updatePurchaseLine(${i},'qty',this.value)"></td>
      <td>${esc(li.unit)}</td>
      <td><input type="number" min="0" step="0.01" value="${li.rate}" style="width:90px" onchange="updatePurchaseLine(${i},'rate',this.value)"></td>
      <td><select style="width:100px" onchange="updatePurchaseLine(${i},'priceMode',this.value)">
        <option value="incl" ${mode==='incl'?'selected':''}>Incl. GST</option>
        <option value="excl" ${mode==='excl'?'selected':''}>Excl. GST</option>
      </select></td>
      <td><select style="width:80px" onchange="updatePurchaseLine(${i},'gstRate',this.value)">
        ${[0,5,12,18,28].map(r => `<option value="${r}" ${Number(li.gstRate)===r ? 'selected' : ''}>${r}%</option>`).join('')}
      </select></td>
      <td>${fmtMoney(taxable)}</td>
      <td>${fmtMoney(gstAmt)}</td>
      <td>${fmtMoney(total)}</td>
      <td><button class="btn small danger" onclick="removePurchaseLineItem(${i})">✕</button></td>
    </tr>`;
  }).join('');
  tbody.querySelectorAll('.pur-line-product').forEach((sel, i) => {
    fillPurchaseProductOptions(sel);
    sel.value = purchaseLineItems[i].productId;
  });
  recalcPurchaseTotals();
}
function onPurchaseProductPick(idx, productId){
  const p = purchaseProductsCache.find(x => x.id === productId);
  if(!p) return;
  const supplierId = document.getElementById('purSupplier').value;
  const last = supplierId ? getLastPriceForSupplierProduct(supplierId, productId) : null;
  purchaseLineItems[idx] = {
    productId, name:p.name, unit:p.unit, hsn: p.hsn || '',
    qty: purchaseLineItems[idx].qty || 1,
    rate: last ? last.rate : 0,
    gstRate: last ? last.gstRate : 0,
    priceMode: last ? last.priceMode : 'incl'
  };
  renderPurchaseLineItems();
  if(last){
    const modeLabel = last.priceMode === 'excl' ? 'excl. GST' : 'incl. GST';
    showMsg('purchaseMsg', `Filled in the last price paid to this supplier for ${p.name}: ₹${fmtMoney(last.rate)} ${modeLabel} (${last.gstRate}% GST) on ${last.date}. Adjust it if this purchase is different.`, true);
  } else {
    showMsg('purchaseMsg', `No earlier purchase of ${p.name} from this supplier found — enter the price, price type, and GST rate manually.`, true);
  }
}
function onPurchaseSupplierChange(){
  const supplierId = document.getElementById('purSupplier').value;
  if(supplierId){
    purchaseLineItems.forEach(li => {
      if(!li.productId) return;
      const last = getLastPriceForSupplierProduct(supplierId, li.productId);
      if(last){ li.rate = last.rate; li.gstRate = last.gstRate; li.priceMode = last.priceMode; }
    });
  }
  renderPurchaseLineItems(); // also refreshes the totals box + balance preview
}
function updatePurchaseLine(idx, field, value){
  purchaseLineItems[idx][field] = field === 'priceMode' ? value : (parseFloat(value) || 0);
  renderPurchaseLineItems();
}
function recalcPurchaseTotals(){
  let subtotal = 0, gstTotal = 0;
  purchaseLineItems.forEach(li => {
    const { taxable, gstAmt } = purchaseLineCalc(li);
    subtotal += taxable;
    gstTotal += gstAmt;
  });
  const grand = subtotal + gstTotal;
  const box = document.getElementById('purchaseTotalsBox');
  if(box){
    box.innerHTML = `
      <div class="totals-row"><span>Taxable value</span><span>${fmtMoney(subtotal)}</span></div>
      <div class="totals-row"><span>GST</span><span>${fmtMoney(gstTotal)}</span></div>
      <div class="totals-row grand"><span>Purchase price incl. GST</span><span>${fmtMoney(grand)}</span></div>`;
  }
  const previewEl = document.getElementById('purBalancePreview');
  if(previewEl){
    const supplierId = document.getElementById('purSupplier').value;
    const priorBalance = supplierId ? getSupplierBalance(supplierId) : 0;
    const paidNow = parseFloat(document.getElementById('purPaidNow').value) || 0;
    previewEl.value = supplierId ? '₹' + fmtMoney(priorBalance + grand - paidNow) : '';
  }
  return {subtotal, gstTotal, grand};
}
async function savePurchase(){
  const supId = document.getElementById('purSupplier').value;
  const supplier = suppliersCache.find(s => s.id === supId);
  if(!supplier){ showMsg('purchaseMsg', 'Select a supplier first.', false); return; }
  const validItems = purchaseLineItems.filter(li => li.productId);
  if(!validItems.length){ showMsg('purchaseMsg', 'Add at least one product line.', false); return; }

  const editId = document.getElementById('purEditId').value;
  const dateVal = document.getElementById('purDate').value || new Date().toISOString().slice(0,10);
  const totals = recalcPurchaseTotals();
  const items = validItems.map(li => {
    const { taxable, gstAmt, total } = purchaseLineCalc(li);
    // Snapshot which billing product this restocks AT THE TIME OF PURCHASE.
    // If the Purchase Product's link is later changed or removed, this old
    // purchase must still reverse/reapply stock against the SAME product it
    // originally affected — not whatever the link happens to be now.
    const purchaseProduct = purchaseProductsCache.find(p => p.id === li.productId);
    return { ...li, taxable, gstAmt, total, linkedProductId: (purchaseProduct && purchaseProduct.linkedProductId) || null };
  });

  if(editId){
    // Editing an existing purchase: undo the old stock-in effect first (using
    // the quantities as they were before this edit), save the new details,
    // then re-apply stock-in with the edited quantities. Payments already
    // recorded against this purchase are untouched — the paid-now field only
    // records a brand new payment, same as it does for a fresh purchase.
    const original = purchasesCache.find(p => p.id === editId);
    if(original){
      await reverseStockForPurchaseItems(original.items || [], dateVal, `Correction: purchase on ${original.date} edited`);
    }
    await db.collection('users').doc(currentUser.uid).collection('purchases').doc(editId).set({
      supplierId: supId, supplierName: supplier.name, date: dateVal,
      items, subtotal: totals.subtotal, gstTotal: totals.gstTotal, grandTotal: totals.grand,
      createdAt: (original && original.createdAt) || firebase.firestore.FieldValue.serverTimestamp()
    });
    for(const li of items){
      if(li.linkedProductId){
        await addStockMovement('purchase-in', li.linkedProductId, li.qty, dateVal, `Purchase from ${supplier.name} (edited)`);
      }
    }
    await loadProducts();
    await loadStockMovements();

    const paidNow = parseFloat(document.getElementById('purPaidNow').value) || 0;
    if(paidNow > 0){
      await db.collection('users').doc(currentUser.uid).collection('payments').add({
        supplierId: supId, supplierName: supplier.name, date: dateVal, amount: paidNow,
        mode: 'On purchase', note: `Paid against purchase dated ${dateVal}`, purchaseId: editId,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await loadPayments();
    }

    // loadPurchases() MUST run before this message: getSupplierBalance() reads
    // the in-memory purchasesCache, which still held this purchase's PRE-EDIT
    // grandTotal until the cache is refreshed — showing a stale balance for a
    // moment right after an edit that changed the amount.
    await loadPurchases();
    showMsg('purchaseMsg', `Purchase updated. Balance now ₹${fmtMoney(getSupplierBalance(supId))}.`, true);
    cancelEditPurchase();
    return;
  }

  const paidNow = parseFloat(document.getElementById('purPaidNow').value) || 0;
  const purchaseData = {
    supplierId: supId, supplierName: supplier.name, date: dateVal,
    items, subtotal: totals.subtotal, gstTotal: totals.gstTotal, grandTotal: totals.grand,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  };
  const ref = await db.collection('users').doc(currentUser.uid).collection('purchases').add(purchaseData);

  // Stock IN: any purchase line whose Purchase Product is linked to a billing
  // Product automatically adds the purchased quantity to that product's stock.
  let stockedItems = 0;
  for(const li of items){
    if(li.linkedProductId){
      await addStockMovement('purchase-in', li.linkedProductId, li.qty, dateVal, `Purchase from ${supplier.name}`);
      stockedItems++;
    }
  }
  if(stockedItems > 0){ await loadProducts(); await loadStockMovements(); }

  const priorBalance = getSupplierBalance(supId);

  if(paidNow > 0){
    await db.collection('users').doc(currentUser.uid).collection('payments').add({
      supplierId: supId, supplierName: supplier.name, date: dateVal, amount: paidNow,
      mode: 'On purchase', note: `Paid against purchase dated ${dateVal}`, purchaseId: ref.id,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await loadPayments();
  }

  const newBalance = priorBalance + totals.grand - paidNow;
  showMsg('purchaseMsg', paidNow > 0
    ? `Purchase saved and ₹${fmtMoney(paidNow)} recorded as paid to ${supplier.name}. Balance now ₹${fmtMoney(newBalance)}.`
    : `Purchase saved. Balance now ₹${fmtMoney(newBalance)}.`, true);

  purchaseLineItems = [];
  addPurchaseLineItem();
  document.getElementById('purSupplier').value = '';
  document.getElementById('purPaidNow').value = '0'; updateAmountWords('purPaidNow','purPaidNowWords');
  await loadPurchases();
}
async function loadPurchases(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('purchases').orderBy('date','desc').get();
  purchasesCache = snap.docs.map(d => ({id:d.id, ...d.data()})).filter(p => !p.deleted);
  renderPurchases();
  recalcPurchaseTotals();
  refreshOpenDashboard();
}
function renderPurchases(){
  const tbody = document.getElementById('purchasesTable');
  if(!tbody) return;
  const rows = [];
  purchasesCache.filter(p => dateInRange(p.date, 'purchaseHistFrom', 'purchaseHistTo')).forEach(p => {
    (p.items||[]).forEach(li => {
      rows.push(`<tr>
        <td>${esc(p.date)}</td>
        <td><a href="#" onclick="openSupplierLedger('${p.supplierId}');return false;">${esc(p.supplierName)}</a>${p.gstFiled ? ' <span class="badge" title="Filed as part of GST period '+esc(p.gstFiledPeriod||'')+'">Filed</span>' : ''}</td>
        <td>${esc(li.name)}</td>
        <td>${li.qty} ${esc(li.unit)}</td>
        <td>₹${fmtMoney(li.total)}</td>
        <td class="row-actions">
          ${p.gstFiled
            ? `<button class="btn small" disabled title="Filed in a GST return — can't be edited or deleted">Edit</button><button class="btn small" disabled title="Filed in a GST return — can't be deleted">Delete</button>`
            : `<button class="btn small" onclick="editPurchase('${p.id}')">Edit</button><button class="btn small danger" onclick="deletePurchase('${p.id}')">Delete</button>`}
        </td>
      </tr>`);
    });
  });
  tbody.innerHTML = rows.join('') || '<tr><td colspan="6" style="color:var(--muted)">No purchases recorded yet.</td></tr>';
}
async function deletePurchase(id){
  const purchase = purchasesCache.find(p => p.id === id);
  if(purchase && purchase.gstFiled){
    alert(`This purchase was filed as part of the ${purchase.gstFiledPeriod||''} GST return and can't be deleted.`);
    return;
  }
  if(!confirm('Move this purchase to the Recycle Bin? Any stock it added will be reversed. You can restore it within 30 days.')) return;
  if(purchase){
    await reverseStockForPurchaseItems(purchase.items || [], new Date().toISOString().slice(0,10), `Reversed: deleted purchase dated ${purchase.date}`);
  }
  await db.collection('users').doc(currentUser.uid).collection('purchases').doc(id).update({
    deleted: true, deletedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await loadProducts();
  await loadStockMovements();
  loadPurchases();
}
/* Undoes the stock-in effect of a purchase's line items — used when a
   purchase is deleted, and when it's edited (old effect reversed, then the
   new one re-applied with the edited quantities). */
async function reverseStockForPurchaseItems(items, date, note){
  for(const li of items){
    if(li.linkedProductId){
      await addStockMovement('adjustment', li.linkedProductId, -li.qty, date, note);
    }
  }
}

/* ---------------- Recycle Bin (soft-deleted purchases & payments, 30-day auto-purge) ---------------- */
const TRASH_RETENTION_DAYS = 30;
let trashedPurchasesCache = [];
let trashedPaymentsCache = [];
let trashedInvoicesCache = [];
function trashDeletedAtMs(doc){
  // deletedAt is a Firestore server timestamp once it round-trips back from
  // Firestore; fall back to "now" only if it's somehow still missing.
  return doc.deletedAt && doc.deletedAt.toDate ? doc.deletedAt.toDate().getTime() : Date.now();
}
async function loadTrash(){
  const [purchSnap, paySnap, invSnap] = await Promise.all([
    db.collection('users').doc(currentUser.uid).collection('purchases').where('deleted','==',true).get(),
    db.collection('users').doc(currentUser.uid).collection('payments').where('deleted','==',true).get(),
    db.collection('users').doc(currentUser.uid).collection('invoices').where('deleted','==',true).get()
  ]);
  trashedPurchasesCache = purchSnap.docs.map(d => ({id:d.id, ...d.data()}));
  trashedPaymentsCache = paySnap.docs.map(d => ({id:d.id, ...d.data()}));
  trashedInvoicesCache = invSnap.docs.map(d => ({id:d.id, ...d.data()}));

  // Auto-purge anything past the retention window before rendering, so the
  // bin never grows forever and the person never has to remember to empty it.
  // Filed invoices are exempt from auto-purge — they're compliance records,
  // not something that should silently vanish after 30 days regardless of
  // whether the person meant to keep it that long.
  const cutoff = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const purchasesToPurge = trashedPurchasesCache.filter(p => trashDeletedAtMs(p) < cutoff);
  const paymentsToPurge = trashedPaymentsCache.filter(p => trashDeletedAtMs(p) < cutoff);
  const invoicesToPurge = trashedInvoicesCache.filter(i => !i.gstFiled && trashDeletedAtMs(i) < cutoff);
  for(const p of purchasesToPurge){
    await db.collection('users').doc(currentUser.uid).collection('purchases').doc(p.id).delete();
  }
  for(const p of paymentsToPurge){
    await db.collection('users').doc(currentUser.uid).collection('payments').doc(p.id).delete();
  }
  for(const i of invoicesToPurge){
    await db.collection('users').doc(currentUser.uid).collection('invoices').doc(i.id).delete();
  }
  if(purchasesToPurge.length) trashedPurchasesCache = trashedPurchasesCache.filter(p => !purchasesToPurge.includes(p));
  if(paymentsToPurge.length) trashedPaymentsCache = trashedPaymentsCache.filter(p => !paymentsToPurge.includes(p));
  if(invoicesToPurge.length) trashedInvoicesCache = trashedInvoicesCache.filter(i => !invoicesToPurge.includes(i));

  trashedPurchasesCache.sort((a,b) => trashDeletedAtMs(b) - trashDeletedAtMs(a));
  trashedPaymentsCache.sort((a,b) => trashDeletedAtMs(b) - trashDeletedAtMs(a));
  trashedInvoicesCache.sort((a,b) => trashDeletedAtMs(b) - trashDeletedAtMs(a));
  renderTrash();
}
function renderTrash(){
  const purchTbody = document.getElementById('trashPurchasesTable');
  if(purchTbody){
    purchTbody.innerHTML = trashedPurchasesCache.map(p => {
      const itemsSummary = (p.items||[]).map(li => `${esc(li.name)} (${li.qty} ${esc(li.unit)})`).join(', ');
      const deletedOn = p.deletedAt && p.deletedAt.toDate ? p.deletedAt.toDate().toISOString().slice(0,10) : '';
      return `<tr>
        <td>${esc(p.date)}</td><td>${esc(p.supplierName)}</td><td>${itemsSummary}</td><td>₹${fmtMoney(p.grandTotal)}</td><td>${esc(deletedOn)}</td>
        <td class="row-actions"><button class="btn small" onclick="restorePurchase('${p.id}')">Restore</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="color:var(--muted)">Nothing here.</td></tr>';
  }
  const payTbody = document.getElementById('trashPaymentsTable');
  if(payTbody){
    payTbody.innerHTML = trashedPaymentsCache.map(p => {
      const deletedOn = p.deletedAt && p.deletedAt.toDate ? p.deletedAt.toDate().toISOString().slice(0,10) : '';
      return `<tr>
        <td>${esc(p.date)}</td><td>${esc(p.supplierName)}</td><td>₹${fmtMoney(p.amount)}</td><td>${esc(deletedOn)}</td>
        <td class="row-actions"><button class="btn small" onclick="restorePayment('${p.id}')">Restore</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" style="color:var(--muted)">Nothing here.</td></tr>';
  }
  const invTbody = document.getElementById('trashInvoicesTable');
  if(invTbody){
    invTbody.innerHTML = trashedInvoicesCache.map(i => {
      const deletedOn = i.deletedAt && i.deletedAt.toDate ? i.deletedAt.toDate().toISOString().slice(0,10) : '';
      return `<tr>
        <td>${esc(i.invoiceNo||'')}</td><td>${esc(i.date||'')}</td><td>${esc(i.customer?.name||'')}</td><td>₹${fmtMoney(i.grandTotal)}</td><td>${esc(deletedOn)}</td>
        <td class="row-actions"><button class="btn small" onclick="restoreInvoice('${i.id}')">Restore</button></td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" style="color:var(--muted)">Nothing here.</td></tr>';
  }
}
async function restorePurchase(id){
  const purchase = trashedPurchasesCache.find(p => p.id === id);
  if(!purchase) return;
  await db.collection('users').doc(currentUser.uid).collection('purchases').doc(id).update({ deleted: false, deletedAt: null });
  // Re-apply the stock-in effect that was reversed when this was deleted.
  for(const li of (purchase.items || [])){
    if(li.linkedProductId){
      await addStockMovement('purchase-in', li.linkedProductId, li.qty, new Date().toISOString().slice(0,10), `Restored purchase dated ${purchase.date}`);
    }
  }
  await loadProducts();
  await loadStockMovements();
  await loadPurchases();
  await loadTrash();
}
async function restorePayment(id){
  await db.collection('users').doc(currentUser.uid).collection('payments').doc(id).update({ deleted: false, deletedAt: null });
  await loadPayments();
  await loadTrash();
}
async function restoreInvoice(id){
  await db.collection('users').doc(currentUser.uid).collection('invoices').doc(id).update({ deleted: false, deletedAt: null });
  await loadInvoices();
  await loadTrash();
}

function editPurchase(id){
  const purchase = purchasesCache.find(p => p.id === id);
  if(!purchase) return;
  activateView('purchases');
  document.getElementById('purEditId').value = id;
  document.getElementById('purSupplier').value = purchase.supplierId;
  document.getElementById('purDate').value = purchase.date;
  document.getElementById('purPaidNow').value = '0'; updateAmountWords('purPaidNow','purPaidNowWords');
  // Carries hsn forward from the saved item, and backfills it from the
  // Purchase Product's CURRENT hsn when the saved item has none — otherwise
  // editing an old purchase (recorded before hsn existed, or before it was
  // filled in for that product) would silently drop/never gain hsn on save.
  purchaseLineItems = (purchase.items || []).map(li => ({
    productId: li.productId, name: li.name, unit: li.unit, qty: li.qty, rate: li.rate, gstRate: li.gstRate,
    hsn: li.hsn || (purchaseProductsCache.find(p => p.id === li.productId) || {}).hsn || ''
  }));
  if(!purchaseLineItems.length) purchaseLineItems.push({productId:'', name:'', unit:'PCS', qty:1, rate:0, gstRate:0});
  renderPurchaseLineItems();
  document.getElementById('purFormTitle').textContent = 'Edit Purchase';
  document.getElementById('purSaveBtn').textContent = 'Update Purchase';
  document.getElementById('purCancelEditBtn').classList.remove('hidden');
  showMsg('purchaseMsg', 'Editing this purchase — the amount-paid field above only records a NEW payment on save; it won\'t change payments already recorded.', true);
}
function cancelEditPurchase(){
  document.getElementById('purEditId').value = '';
  document.getElementById('purSupplier').value = '';
  document.getElementById('purPaidNow').value = '0'; updateAmountWords('purPaidNow','purPaidNowWords');
  purchaseLineItems = [];
  addPurchaseLineItem();
  document.getElementById('purFormTitle').textContent = 'New Purchase';
  document.getElementById('purSaveBtn').textContent = 'Save Purchase';
  document.getElementById('purCancelEditBtn').classList.add('hidden');
  showMsg('purchaseMsg', '', true);
}

/* ---------------- Payments made to suppliers ---------------- */
async function loadPayments(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('payments').orderBy('date','desc').get();
  paymentsCache = snap.docs.map(d => ({id:d.id, ...d.data()})).filter(p => !p.deleted);
  refreshOpenDashboard();
  renderPaymentsTable();
}
async function deletePayment(id){
  if(!confirm('Move this payment to the Recycle Bin? You can restore it within 30 days.')) return;
  await db.collection('users').doc(currentUser.uid).collection('payments').doc(id).update({
    deleted: true, deletedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await loadPayments();
  if(currentLedgerSupplierId) renderSupplierLedger(currentLedgerSupplierId);
}
function editPayment(id){
  const p = paymentsCache.find(x => x.id === id);
  if(!p) return;
  document.getElementById('editPayId').value = id;
  document.getElementById('editPayDate').value = p.date;
  document.getElementById('editPayAmount').value = p.amount;
  document.getElementById('editPayMode').value = p.mode || '';
  document.getElementById('editPayNote').value = p.note || '';
  document.getElementById('editPayMsg').textContent = '';
  document.getElementById('editPaymentModal').classList.remove('hidden');
}
function closeEditPaymentModal(){
  document.getElementById('editPaymentModal').classList.add('hidden');
}
async function saveEditedPayment(){
  const id = document.getElementById('editPayId').value;
  const existing = paymentsCache.find(p => p.id === id);
  if(!existing) return;
  const amount = parseFloat(document.getElementById('editPayAmount').value) || 0;
  const dateVal = document.getElementById('editPayDate').value || existing.date;
  const mode = document.getElementById('editPayMode').value.trim();
  const note = document.getElementById('editPayNote').value.trim();
  if(amount <= 0){ showMsg('editPayMsg', 'Enter an amount greater than zero.', false); return; }

  await db.collection('users').doc(currentUser.uid).collection('payments').doc(id).set({
    supplierId: existing.supplierId, supplierName: existing.supplierName,
    date: dateVal, amount, mode, note,
    purchaseId: existing.purchaseId || null,
    createdAt: existing.createdAt || firebase.firestore.FieldValue.serverTimestamp()
  });
  closeEditPaymentModal();
  await loadPayments();
  if(currentLedgerSupplierId) renderSupplierLedger(currentLedgerSupplierId);
}

/* ---------------- Payment Entry (standalone page — log a payment any time, not tied to a purchase) ---------------- */
async function savePaymentEntry(){
  const supplierId = document.getElementById('payEntrySupplier').value;
  const supplier = suppliersCache.find(s => s.id === supplierId);
  if(!supplier){ showMsg('paymentEntryMsg', 'Select a supplier first.', false); return; }
  const amount = parseFloat(document.getElementById('payEntryAmount').value) || 0;
  if(amount <= 0){ showMsg('paymentEntryMsg', 'Enter a payment amount greater than zero.', false); return; }
  const dateVal = document.getElementById('payEntryDate').value || new Date().toISOString().slice(0,10);
  const mode = document.getElementById('payEntryMode').value.trim();
  const note = document.getElementById('payEntryNote').value.trim();

  await db.collection('users').doc(currentUser.uid).collection('payments').add({
    supplierId, supplierName: supplier.name, date: dateVal, amount, mode, note,
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await loadPayments();

  ['payEntryAmount','payEntryMode','payEntryNote'].forEach(f => document.getElementById(f).value = '');
  updateAmountWords('payEntryAmount','payEntryAmountWords');
  showMsg('paymentEntryMsg', `Payment of ₹${fmtMoney(amount)} recorded for ${supplier.name}. Balance now ₹${fmtMoney(getSupplierBalance(supplierId))}.`, true);
}
function renderPaymentsTable(){
  const tbody = document.getElementById('paymentsEntryTable');
  if(!tbody) return;
  tbody.innerHTML = paymentsCache.filter(p => dateInRange(p.date, 'paymentHistFrom', 'paymentHistTo')).map(p => `
    <tr>
      <td>${esc(p.date)}</td>
      <td><a href="#" onclick="goToSupplierDashboard('${p.supplierId}');return false;">${esc(p.supplierName)}</a></td>
      <td>₹${fmtMoney(p.amount)}</td>
      <td>${esc(p.mode||'—')}</td>
      <td>${esc(p.note||'')}</td>
      <td class="row-actions"><button class="btn small" onclick="editPayment('${p.id}')">Edit</button><button class="btn small danger" onclick="deletePayment('${p.id}')">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">No payments recorded yet.</td></tr>';
}
function goToSupplierDashboard(supplierId){
  activateView('supplier-dashboard');
  const sel = document.getElementById('dashSupplier');
  if(sel){ sel.value = supplierId; renderSupplierDashboard(supplierId); }
}

/* ---------------- Supplier ledger (product-wise, date-wise purchases + payments) ---------------- */
function openSupplierLedger(supplierId){
  currentLedgerSupplierId = supplierId;
  document.getElementById('ledgerModal').classList.remove('hidden');
  document.getElementById('ledgerPayDate').valueAsDate = new Date();
  document.getElementById('ledgerPayAmount').value = '';
  document.getElementById('ledgerPayMode').value = '';
  document.getElementById('ledgerPayNote').value = '';
  renderSupplierLedger(supplierId);
}
function closeSupplierLedger(){
  document.getElementById('ledgerModal').classList.add('hidden');
  currentLedgerSupplierId = null;
}
function renderSupplierLedger(supplierId){
  const supplier = suppliersCache.find(s => s.id === supplierId);
  if(!supplier) return;
  document.getElementById('ledgerSupplierName').textContent = supplier.name;

  const purchases = purchasesCache.filter(p => p.supplierId === supplierId);
  const payments = paymentsCache.filter(p => p.supplierId === supplierId);

  const rows = [];
  purchases.forEach(p => (p.items||[]).forEach(li => {
    rows.push({ date:p.date, type:'purchase', desc:`${li.name} @ ₹${fmtMoney(li.rate)} ${li.priceMode==='excl' ? 'excl. GST' : 'incl. GST'} (${li.gstRate}% GST)`, qty:`${li.qty} ${li.unit}`, debit:li.total, credit:0, purchaseId:p.id });
  }));
  payments.forEach(pay => {
    const label = pay.note ? `Payment (${pay.mode || '—'}) — ${pay.note}` : `Payment (${pay.mode || '—'})`;
    rows.push({ date:pay.date, type:'payment', desc:label, qty:'', debit:0, credit:pay.amount, paymentId:pay.id });
  });
  rows.sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  let totalPurchase = 0, totalPaid = 0, running = 0;
  const tbody = document.getElementById('ledgerTable');
  tbody.innerHTML = rows.map(r => {
    running += r.debit - r.credit;
    totalPurchase += r.debit; totalPaid += r.credit;
    const actions = r.purchaseId
      ? `<button class="btn small" onclick="editPurchase('${r.purchaseId}')">Edit</button>`
      : `<button class="btn small" onclick="editPayment('${r.paymentId}')">Edit</button><button class="btn small danger" onclick="deletePayment('${r.paymentId}')">Delete</button>`;
    return `<tr>
      <td>${esc(r.date)}</td>
      <td><span class="badge">${r.type === 'purchase' ? 'Purchase' : 'Payment'}</span></td>
      <td>${esc(r.desc)}</td>
      <td>${esc(r.qty)}</td>
      <td>${r.debit ? '₹'+fmtMoney(r.debit) : ''}</td>
      <td>${r.credit ? '₹'+fmtMoney(r.credit) : ''}</td>
      <td>₹${fmtMoney(running)}</td>
      <td class="row-actions">${actions}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="color:var(--muted)">No purchases or payments recorded for this supplier yet.</td></tr>';

  document.getElementById('ledgerTotalPurchase').textContent = '₹' + fmtMoney(totalPurchase);
  document.getElementById('ledgerTotalPaid').textContent = '₹' + fmtMoney(totalPaid);
  document.getElementById('ledgerBalance').textContent = '₹' + fmtMoney(totalPurchase - totalPaid);
}
async function recordSupplierPayment(){
  if(!currentLedgerSupplierId) return;
  const supplier = suppliersCache.find(s => s.id === currentLedgerSupplierId);
  const amount = parseFloat(document.getElementById('ledgerPayAmount').value) || 0;
  const dateVal = document.getElementById('ledgerPayDate').value || new Date().toISOString().slice(0,10);
  const mode = document.getElementById('ledgerPayMode').value.trim();
  const note = document.getElementById('ledgerPayNote').value.trim();
  if(amount <= 0){ showMsg('ledgerPayMsg', 'Enter a payment amount greater than zero.', false); return; }

  const data = { supplierId: currentLedgerSupplierId, supplierName: supplier.name, date: dateVal, amount, mode, note, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
  await db.collection('users').doc(currentUser.uid).collection('payments').add(data);

  document.getElementById('ledgerPayAmount').value = '';
  document.getElementById('ledgerPayMode').value = '';
  document.getElementById('ledgerPayNote').value = '';
  showMsg('ledgerPayMsg', 'Payment recorded.', true);
  await loadPayments();
  renderSupplierLedger(currentLedgerSupplierId);
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
  tbody.innerHTML = lineItems.map((li, i) => {
    const taxable = lineTaxable(li);
    const gstAmt = taxable * (li.gstRate||0) / 100;
    return `
    <tr>
      <td><select class="line-product" onchange="onProductPick(${i}, this.value)">${''}</select></td>
      <td><input type="number" min="0" step="1" value="${li.qty}" style="width:60px" onchange="updateLine(${i},'qty',this.value)"></td>
      <td>${esc(li.unit)}</td>
      <td><input type="number" min="0" step="0.01" value="${li.rate}" style="width:80px" onchange="updateLine(${i},'rate',this.value)"></td>
      <td><input type="number" min="0" max="100" step="0.01" value="${li.discount}" style="width:60px" onchange="updateLine(${i},'discount',this.value)"></td>
      <td>${fmtMoney(taxable)}</td>
      <td>${li.gstRate}%</td>
      <td>${fmtMoney(gstAmt)}</td>
      <td>${fmtMoney(taxable + gstAmt)}</td>
      <td><button class="btn small danger" onclick="removeLineItem(${i})">✕</button></td>
    </tr>`;
  }).join('');
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
  // Without a state code on both sides, sameState below silently falls back to
  // false (IGST) even for an actual same-state sale — wrong tax head on a GST
  // invoice, not just a display issue. Block instead of guessing.
  if(!customer.stateCode){ showMsg('invoiceMsg', `${customer.name} has no state code saved — CGST/SGST vs IGST can't be determined correctly. Edit this customer first.`, false); return; }
  if(!businessData.stateCode){ showMsg('invoiceMsg', 'Your Business Profile has no state code saved — complete it before invoicing.', false); return; }

  showMsg('invoiceMsg', 'Saving invoice…', true);
  const dateVal = document.getElementById('invDate').value || new Date().toISOString().slice(0,10);
  const invoiceDate = parseLocalDate(dateVal);
  const invoiceNo = await nextInvoiceNumber(invoiceDate);
  const totals = recalcTotals();
  const reverseCharge = document.getElementById('invReverseCharge').checked;

  const invoiceData = {
    invoiceNo, date: dateVal, reverseCharge,
    sellerUid: currentUser.uid, // required so the public_invoices Firestore rule can enforce ownership
    business: { ...businessData },
    customerId: custId, // lets Customer Dashboard match invoices reliably — older invoices predate this field, see its fallback match
    customer: { legalName:customer.legalName, name:customer.name, gstin:customer.gstin, address:customer.address, state:customer.state, stateCode:customer.stateCode, email:customer.email },
    items: lineItems.map(li => ({...li, taxable: lineTaxable(li)})),
    subtotal: totals.subtotal, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, grandTotal: totals.grand,
    sameState: totals.sameState,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    emailSent: false
  };

  const ref = await db.collection('users').doc(currentUser.uid).collection('invoices').add(invoiceData);

  // Receivables: if the customer paid something at the moment of billing,
  // log it as a receipt right away — same idea as Purchase Entry's "amount
  // paid now" writing a payment, just the receivables mirror of it.
  const receivedNow = parseFloat(document.getElementById('invReceivedNow').value) || 0;
  if(receivedNow > 0){
    await db.collection('users').doc(currentUser.uid).collection('receipts').add({
      customerId: custId, customerName: customer.name, date: dateVal, amount: receivedNow,
      mode: '', note: `Received with Invoice ${invoiceNo}`,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  // Stock OUT: every line item on a saved GST invoice reduces that product's
  // stock, same as a monthly marketplace upload would — logged individually so
  // each sale shows up in Stock Movement History with a reference to the invoice.
  const stockItems = invoiceData.items.filter(li => li.productId);
  for(const li of stockItems){
    await addStockMovement('sale-out', li.productId, -(li.qty||0), dateVal, `Invoice ${invoiceNo} — sold to ${customer.name}`);
  }
  if(stockItems.length){ await loadProducts(); await loadStockMovements(); }

  // This customer is also a linked VISUTRA buyer — meaning this sale, even
  // though it came in through some other channel (phone, WhatsApp, in
  // person) rather than through Place Order, still has a real buyer account
  // on the other end whose own stock should reflect it. Rather than silently
  // pushing a purchase into their account, this proposes it as an order for
  // them to confirm — same shape as an accepted marketplace order, so the
  // EXISTING buyer-side auto-purchase logic (my-orders.html) picks it up
  // automatically the moment they approve, with no separate code path.
  if(customer.linkedBuyerUid && customer.linkStatus === 'ACTIVE'){
    try{
      await db.collection('marketplaceOrders').add({
        buyerUid: customer.linkedBuyerUid, buyerEmail: customer.linkedBuyerEmail || customer.email || '',
        sellerUid: currentUser.uid, sellerName: businessData.businessName || currentUser.email,
        status: 'PENDING_BUYER_CONFIRMATION', orderType: 'SELLER_RECORDED',
        orderNumber: invoiceNo,
        items: stockItems.map(li => ({
          productId: li.productId, productName: li.name, sellerSku: (productsCache.find(p => p.id === li.productId) || {}).sku || '',
          unit: li.unit || 'PCS', hsn: li.hsn || '', qty: li.qty, rate: li.rate || 0, gstRate: li.gstRate || 0,
          taxable: li.taxable || 0, gstAmt: fix2((li.taxable||0) * (li.gstRate||0) / 100), total: fix2((li.taxable||0) * (1 + (li.gstRate||0)/100))
        })),
        invoiceId: ref.id, invoiceNo,
        invoiceSummary: { subtotal: totals.subtotal, cgst: totals.cgst, sgst: totals.sgst, igst: totals.igst, grandTotal: totals.grand },
        buyerBusiness: { businessName: customer.name, gstin: customer.gstin, address: customer.address, state: customer.state, stateCode: customer.stateCode, email: customer.email },
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }catch(err){
      // Non-fatal — the invoice itself is already saved and correct on your
      // side; only the buyer-side notification failed to go out.
      console.error('Could not notify linked buyer of this invoice:', err);
    }
  }

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
      showMsg('invoiceMsg', 'Invoice saved and downloaded, but the email failed to send: ' + (err.text || err.message || 'Unknown error'), false);
    }
  } else {
    showMsg('invoiceMsg', 'Invoice saved and downloaded.', true);
  }

  lineItems = [];
  addLineItem();
  document.getElementById('invReceivedNow').value = '0';
  updateAmountWords('invReceivedNow','invReceivedNowWords');
  loadInvoices();
  if(receivedNow > 0){ loadReceipts(); refreshOpenCustomerDashboard(); }
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
  // GST invoices are conventionally headed with the supplier's LEGAL name
  // (as registered against the GSTIN) — the business/trade name, if
  // different, follows as a smaller "Trading as" line. Falls back to the
  // business name alone for anyone who hasn't filled in Legal Name yet.
  doc.text(inv.business.legalName || inv.business.businessName || '', 40, y);
  y += 14;
  if(inv.business.legalName && inv.business.businessName && inv.business.businessName !== inv.business.legalName){
    doc.setFont('helvetica','normal'); doc.setFontSize(9);
    doc.text(`Trading as: ${inv.business.businessName}`, 40, y);
    y += 12;
  }
  doc.setFont('helvetica','normal'); doc.setFontSize(9.5);
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
  // Same legal-name-first convention as the seller's own header above.
  doc.text(inv.customer.legalName || inv.customer.name || '', 40, y); y += 12;
  if(inv.customer.legalName && inv.customer.name && inv.customer.name !== inv.customer.legalName){
    doc.setFontSize(8.5);
    doc.text(`Trading as: ${inv.customer.name}`, 40, y); y += 11;
    doc.setFontSize(9.5);
  }
  const custAddrLines = doc.splitTextToSize(inv.customer.address || '', 300);
  doc.text(custAddrLines, 40, y); y += custAddrLines.length * 12;
  if(inv.customer.gstin){ doc.text(`GSTIN: ${inv.customer.gstin}`, 40, y); y += 12; }
  doc.text(`State: ${inv.customer.state || ''}`, 40, y);
  y += 22;

  const sameState = inv.sameState;
  const head = sameState
    ? [['#','Description','HSN','Qty','Unit','Rate','Taxable','GST%','CGST','SGST','Total']]
    : [['#','Description','HSN','Qty','Unit','Rate','Taxable','GST%','IGST','Total']];

  const body = inv.items.filter(li => li.productId).map((li, i) => {
    const taxable = li.taxable;
    const taxAmt = taxable * (li.gstRate||0) / 100;
    if(sameState){
      const half = taxAmt/2;
      return [i+1, li.name, li.hsn, li.qty, li.unit, fmtMoney(li.rate), fmtMoney(taxable), `${li.gstRate||0}%`, fmtMoney(half), fmtMoney(half), fmtMoney(taxable+taxAmt)];
    } else {
      return [i+1, li.name, li.hsn, li.qty, li.unit, fmtMoney(li.rate), fmtMoney(taxable), `${li.gstRate||0}%`, fmtMoney(taxAmt), fmtMoney(taxable+taxAmt)];
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

  // Payment details block, bottom left — only drawn if at least one field is
  // filled in, so an invoice from someone who hasn't set this up yet looks
  // exactly as it did before this existed.
  const bank = inv.business.bankDetails || {};
  const hasBankDetails = bank.holderName || bank.bankName || bank.accountNumber || bank.ifsc || bank.upiId || bank.qrImage;
  if(hasBankDetails){
    let by = y + 30;
    doc.setFont('helvetica','bold'); doc.setFontSize(9);
    doc.text('Payment Details', 40, by); by += 13;
    doc.setFont('helvetica','normal'); doc.setFontSize(8.5);
    if(bank.holderName){ doc.text(`Account Holder: ${bank.holderName}`, 40, by); by += 11; }
    if(bank.bankName){ doc.text(`Bank: ${bank.bankName}`, 40, by); by += 11; }
    if(bank.accountNumber){ doc.text(`A/c No: ${bank.accountNumber}`, 40, by); by += 11; }
    if(bank.ifsc){ doc.text(`IFSC: ${bank.ifsc}`, 40, by); by += 11; }
    if(bank.upiId){ doc.text(`UPI: ${bank.upiId}`, 40, by); by += 11; }
    if(bank.qrImage){
      try{ doc.addImage(bank.qrImage, 'PNG', 40, by + 4, 70, 70); }catch(e){}
    }
  }

  // Signature block, bottom right
  const sigY = y - 10;
  doc.setFontSize(9);
  doc.text(`For ${inv.business.legalName || inv.business.businessName || ''}`, pageW-160, sigY, {align:'center'});
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
let invoiceDeleteRequestsCache = {}; // invoiceId -> latest request doc (with id), for THIS seller
async function loadInvoices(){
  const [snap, reqSnap] = await Promise.all([
    db.collection('users').doc(currentUser.uid).collection('invoices').orderBy('createdAt','desc').limit(100).get(),
    db.collection('invoiceDeleteRequests').where('sellerUid','==',currentUser.uid).get()
  ]);
  invoicesCache = {};
  snap.docs.forEach(d => { invoicesCache[d.id] = d.data(); });

  // Keep only the latest request per invoice — a rejected request can be
  // followed by a fresh one, and only the newest should drive the row's state.
  invoiceDeleteRequestsCache = {};
  reqSnap.docs.map(d => ({id:d.id, ...d.data()})).forEach(r => {
    const existing = invoiceDeleteRequestsCache[r.invoiceId];
    const rMs = r.createdAt && r.createdAt.toMillis ? r.createdAt.toMillis() : 0;
    const eMs = existing && existing.createdAt && existing.createdAt.toMillis ? existing.createdAt.toMillis() : -1;
    if(!existing || rMs > eMs) invoiceDeleteRequestsCache[r.invoiceId] = r;
  });

  const rows = [];
  snap.docs.filter(d => !d.data().deleted).filter(d => dateInRange(d.data().date||'', 'invoiceHistFrom', 'invoiceHistTo')).forEach(d => {
    const inv = d.data();
    const items = (inv.items||[]).filter(li => li.productId);
    const req = invoiceDeleteRequestsCache[d.id];
    (items.length ? items : [{name:'—', qty:'', unit:''}]).forEach(li => {
      rows.push(`<tr>
        <td>${esc(inv.invoiceNo||'')}</td><td>${esc(inv.date||'')}</td><td>${esc(inv.customer?.name||'')}</td>
        <td>${esc(li.name||'')}</td><td>${li.qty||''} ${esc(li.unit||'')}</td>
        <td>₹${fmtMoney(inv.grandTotal||0)}</td>
        <td><span class="badge">${inv.emailSent ? 'Sent' : 'Not sent'}</span>${inv.gstFiled ? ' <span class="badge" title="Filed as part of GST period '+esc(inv.gstFiledPeriod||'')+'">Filed</span>' : ''}</td>
        <td class="row-actions">
          <button class="btn small" onclick="redownloadInvoicePdf('${d.id}')">Download PDF</button>
          <a class="btn small" href="invoice-view.html?id=${d.id}" target="_blank">View</a>
          ${deleteActionCell(d.id, inv, req)}
        </td>
      </tr>`);
    });
  });
  document.getElementById('invoicesTable').innerHTML = rows.join('') || '<tr><td colspan="8" style="color:var(--muted)">No invoices yet.</td></tr>';
}
/* Figures out what the Delete cell should show for one invoice row:
   - Filed: locked, no request possible.
   - No order behind it (a regular "New Invoice" to a customer with no
     linked buyer account, or one that's not currently ACTIVE): deletes
     immediately, same as before — there's no one to ask.
   - Has a linked, ACTIVE buyer behind it (an order-derived invoice from
     order-receive.html — sourceOrderId is set): needs the buyer's sign-off
     first, since accepting that order already moved stock on both sides. */
function deleteActionCell(invoiceId, inv, req){
  if(inv.gstFiled) return `<button class="btn small" disabled title="Filed in a GST return — can't be deleted">Delete</button>`;
  if(!inv.sourceOrderId) return `<button class="btn small danger" onclick="deleteInvoice('${invoiceId}')">Delete</button>`;
  if(req){
    if(req.status === 'PENDING') return `<span class="badge" title="Reason: ${escAttr(req.reason||'')}">Waiting for buyer</span>`;
    if(req.status === 'REJECTED') return `<span class="badge" title="Buyer's reason, if any: ${escAttr(req.buyerNote||'')}">Buyer declined</span> <button class="btn small danger" onclick="deleteInvoice('${invoiceId}')">Request again</button>`;
    if(req.status === 'ACCEPTED') return `<button class="btn small danger" onclick="finalizeInvoiceDeletion('${invoiceId}', '${req.id}')">Finalize Deletion</button>`;
  }
  return `<button class="btn small danger" onclick="deleteInvoice('${invoiceId}')">Delete</button>`;
}
function escAttr(s){ return esc(s).replace(/"/g, '&quot;'); }

/* Reverses the stock this invoice originally deducted (every invoice does,
   via the 'sale-out' movement written when it was created — see saveInvoice
   and order-receive.html's Accept flow) — this itself was missing entirely
   before, so ANY invoice deletion was silently leaving Stock overstated. */
async function reverseStockForInvoiceItems(items, note){
  for(const li of (items || [])){
    if(!li.productId || !li.qty) continue;
    await addStockMovement('sale-out', li.productId, li.qty, new Date().toISOString().slice(0,10), note);
  }
}
async function deleteInvoice(id){
  const inv = invoicesCache[id];
  if(inv && inv.gstFiled){
    alert(`This invoice was filed as part of the ${inv.gstFiledPeriod||''} GST return and can't be deleted.`);
    return;
  }
  if(!inv) return;

  // Order-derived invoice: the buyer's own account has a linked purchase
  // record with real stock on their side too, from when they accepted this
  // order — deleting the invoice unilaterally would leave their records
  // (and their stock) referring to a sale that no longer exists on yours.
  if(inv.sourceOrderId){
    const existing = invoiceDeleteRequestsCache[id];
    if(existing && existing.status === 'PENDING'){ alert('A deletion request for this invoice is already waiting on the buyer.'); return; }
    const reason = prompt('This invoice came from an accepted buyer order — deleting it needs their sign-off first, since it affects their stock too.\n\nEnter a reason for the buyer to see:');
    if(reason === null) return; // cancelled
    if(!reason.trim()){ alert('A reason is required so the buyer knows why.'); return; }
    try{
      const orderSnap = await db.collection('marketplaceOrders').doc(inv.sourceOrderId).get();
      const order = orderSnap.exists ? orderSnap.data() : null;
      if(!order || !order.buyerUid){ alert('Could not find the original order for this invoice — it may have been altered. Contact support.'); return; }
      await db.collection('invoiceDeleteRequests').add({
        sellerUid: currentUser.uid, sellerName: businessData.businessName || currentUser.email,
        buyerUid: order.buyerUid, buyerEmail: order.buyerEmail || '',
        invoiceId: id, invoiceNo: inv.invoiceNo || '', orderId: inv.sourceOrderId, orderNumber: order.orderNumber || '',
        reason: reason.trim(), status: 'PENDING',
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      showMsg('invoiceHistMsg', 'Deletion request sent to the buyer — this invoice stays as-is until they respond.', true);
      await loadInvoices();
    }catch(err){
      alert(`Could not send the deletion request: ${err.message}`);
    }
    return;
  }

  // Plain invoice, no order behind it — nobody else's stock depends on it.
  if(!confirm('Move this invoice to the Recycle Bin? Its stock will be reversed. You can restore it within 30 days. Note: this does not cancel or affect any GST filing already submitted using it — issue a credit note for that instead.')) return;
  await reverseStockForInvoiceItems(inv.items, `Reversed: deleted invoice ${inv.invoiceNo||''}`);
  await db.collection('users').doc(currentUser.uid).collection('invoices').doc(id).update({
    deleted: true, deletedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await loadProducts();
  await loadStockMovements();
  await loadInvoices();
}
/* Runs once the buyer has accepted — completes the deletion on the SELLER's
   own side. The buyer already reversed their own stock and purchase record
   the moment they accepted (see buyer/dashboard.html); this is the matching
   seller-side half, kept as a separate manual step because a seller's
   client has no permission to write to the buyer's data, and vice versa —
   each side only ever finalizes its own half once it sees the shared
   request reach the right status. */
async function finalizeInvoiceDeletion(invoiceId, requestId){
  const inv = invoicesCache[invoiceId];
  if(!inv) return;
  if(!confirm('The buyer has approved this deletion. Finalize it now? This moves the invoice to your Recycle Bin and reverses its stock.')) return;
  try{
    await reverseStockForInvoiceItems(inv.items, `Reversed: deleted invoice ${inv.invoiceNo||''} (buyer-approved)`);
    await db.collection('users').doc(currentUser.uid).collection('invoices').doc(invoiceId).update({
      deleted: true, deletedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await db.collection('invoiceDeleteRequests').doc(requestId).update({
      status: 'COMPLETED', completedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    await loadProducts();
    await loadStockMovements();
    await loadInvoices();
  }catch(err){
    alert(`Could not finalize: ${err.message}`);
  }
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
let gstr1Invoices = []; // raw invoices behind the current gstr1Data, kept for the JSON export's per-invoice nesting
let gstr1CurrentPeriod = null; // {label, fileTag} for whatever period is currently on screen — used by markPeriodAsFiled()
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

  let snap;
  try {
    snap = await db.collection('users').doc(currentUser.uid).collection('invoices').get();
  } catch(err) {
    console.error('GSTR-1: failed to read invoices:', err);
    showMsg('gstrMsg', 'Could not read invoices — check your connection and try again (see browser console for details).', false);
    return;
  }
  const invoices = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(inv => !inv.deleted).filter(inv => {
    const d = parseLocalDate(inv.date);
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
      // Backfill from the Product's CURRENT hsn when the saved invoice item
      // has none — older invoices (created before a product had its HSN
      // filled in, or before HSN was tracked at all) would otherwise always
      // report blank HSN in this and every future download, even after the
      // product's HSN gets filled in later.
      const hsn = li.hsn || (productsCache.find(p => p.id === li.productId) || {}).hsn || '';
      const key = hsn + '|' + li.gstRate;
      if(!hsnMap[key]) hsnMap[key] = { hsn, desc: li.name, uqc: li.unit, qty: 0, value: 0, rate: li.gstRate, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
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
  gstr1Invoices = invoices; // kept for the JSON export, which needs per-invoice detail the flattened arrays above don't preserve

  document.getElementById('gstrPeriodLabel').textContent = period.label;
  document.getElementById('gstrB2bCount').textContent = b2b.length;
  document.getElementById('gstrB2clCount').textContent = b2cl.length;
  document.getElementById('gstrB2csCount').textContent = b2cs.length;

  // b2b/b2cl/b2cs/hsn are flat rows already shaped to match the table headers
  // (built above, and also what the Excel export writes) — same arrays, two
  // renderings.
  document.getElementById('gstrB2bTable').innerHTML = b2b.map(r => `
    <tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${esc(r[3])}</td><td>${fmtMoney(r[4])}</td><td>${esc(r[5])}</td><td>${r[9]}%</td><td>${fmtMoney(r[10])}</td></tr>
  `).join('') || '<tr><td colspan="8" style="color:var(--muted)">No B2B sales this period.</td></tr>';
  document.getElementById('gstrB2clTable').innerHTML = b2cl.map(r => `
    <tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${fmtMoney(r[2])}</td><td>${esc(r[3])}</td><td>${r[5]}%</td><td>${fmtMoney(r[6])}</td></tr>
  `).join('') || '<tr><td colspan="6" style="color:var(--muted)">No B2CL sales this period.</td></tr>';
  document.getElementById('gstrB2csTable').innerHTML = b2cs.map(r => `
    <tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${r[3]}%</td><td>${fmtMoney(r[4])}</td></tr>
  `).join('') || '<tr><td colspan="4" style="color:var(--muted)">No B2CS sales this period.</td></tr>';
  document.getElementById('gstrHsnTable').innerHTML = hsn.map(r => `
    <tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${r[3]}</td><td>${r[5]}%</td><td>${fmtMoney(r[6])}</td><td>${fmtMoney(r[7])}</td><td>${fmtMoney(r[8])}</td><td>${fmtMoney(r[9])}</td><td>${fmtMoney(r[4])}</td></tr>
  `).join('') || '<tr><td colspan="10" style="color:var(--muted)">No sales this period.</td></tr>';

  document.getElementById('gstrSummaryCard').classList.remove('hidden');
  // Show the download card as soon as the Sales side is ready — it must not
  // depend on the Purchases step below succeeding, or a failure there (e.g.
  // a transient read error) would hide Excel/JSON even though Sales data,
  // the primary GSTR-1 requirement, is already correctly computed.
  document.getElementById('gstrDownloadCard').classList.remove('hidden');
  document.getElementById('gstrMarkFiledPeriodLabel').textContent = period.label;
  document.getElementById('gstrMarkFiledCard').classList.remove('hidden');
  document.getElementById('gstrMarkFiledMsg').textContent = '';
  gstr1CurrentPeriod = period;

  // Purchases (inward) side, same period, same button — see "Purchase-side
  // GST data" section above. Wrapped so a failure here never blocks the
  // Sales summary or downloads above, which already succeeded.
  try {
    await loadPurchases();
    gstr1PurchaseRows = computePurchaseGstrRows(start, end);
    document.getElementById('pgPeriodLabel').textContent = period.label;
    renderPurchaseGstrSection();
    document.getElementById('pgSummaryCard').classList.remove('hidden');
    showMsg('gstrMsg', `Found ${invoices.length} sale(s) and ${gstr1PurchaseRows.length} purchase(s) in this period.`, true);
  } catch(err) {
    console.error('Purchases side of GSTR-1 failed to load:', err);
    gstr1PurchaseRows = [];
    showMsg('gstrMsg', `Found ${invoices.length} sale(s). Purchases couldn't be loaded (see console) — Sales download is still available below.`, false);
  }
}

function downloadGstr1Excel(){
  if(!gstr1Data) return;
  const wb = XLSX.utils.book_new();
  const b2bHeader = ['GSTIN/UIN of Recipient','Receiver Name','Invoice Number','Invoice date','Invoice Value','Place Of Supply','Reverse Charge','Applicable % of Tax Rate','Invoice Type','Rate','Taxable Value','Cess Amount'];
  const b2clHeader = ['Invoice Number','Invoice date','Invoice Value','Place Of Supply','Applicable % of Tax Rate','Rate','Taxable Value','Cess Amount'];
  const b2csHeader = ['Type','Place Of Supply','Applicable % of Tax Rate','Rate','Taxable Value','Cess Amount'];
  const hsnHeader = ['HSN','Description','UQC','Total Quantity','Total Value','Rate','Taxable Value','Integrated Tax Amount','Central Tax Amount','State/UT Tax Amount','Cess Amount'];

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([b2bHeader].concat(gstr1Data.b2b)), 'Sales - b2b');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([b2clHeader].concat(gstr1Data.b2cl)), 'Sales - b2cl');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([b2csHeader].concat(gstr1Data.b2cs)), 'Sales - b2cs');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hsnHeader].concat(gstr1Data.hsn)), 'Sales - hsn');

  const purHeader = ['Date','Supplier','GSTIN','Taxable Value','GST Amount','Total'];
  const purRows = gstr1PurchaseRows.map(r => [r.date, r.supplierName, r.gstin || '', r.taxable, r.gst, r.total]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([purHeader].concat(purRows)), 'Purchases - Register');

  const purItemsHeader = ['Date','Supplier','Product','HSN','Qty','Unit','GST Rate','Taxable','GST Amount','Total'];
  const purItemsRows = [];
  gstr1PurchaseRows.forEach(r => r.items.forEach(li => {
    purItemsRows.push([r.date, r.supplierName, li.name, li.hsn || '', li.qty, li.unit || '', li.gstRate || 0, li.taxable || 0, li.gstAmt || 0, li.total || 0]);
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([purItemsHeader].concat(purItemsRows)), 'Purchases - Items');

  const byRate = {};
  gstr1PurchaseRows.forEach(r => r.items.forEach(li => {
    const rate = li.gstRate || 0;
    if(!byRate[rate]) byRate[rate] = { taxable: 0, gst: 0 };
    byRate[rate].taxable += li.taxable || 0;
    byRate[rate].gst += li.gstAmt || 0;
  }));
  const purRateHeader = ['GST Rate','Taxable Value','GST Amount','Total'];
  const purRateRows = Object.keys(byRate).map(Number).sort((a,b) => a-b)
    .map(r => [r + '%', byRate[r].taxable, byRate[r].gst, byRate[r].taxable + byRate[r].gst]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([purRateHeader].concat(purRateRows)), 'Purchases - Rate Summary');

  XLSX.writeFile(wb, `GSTR1-Sales-Purchases-${gstr1Data.period}.xlsx`);
}

// GST-offline-tool-style JSON for the Sales/outward side only — there is no
// portal endpoint that accepts a Purchases/inward upload (ITC is populated
// from suppliers' own GSTR-1 filings via 2A/2B), so folding purchase data
// into this file would just be extra fields the real offline tool doesn't
// expect. Structure follows the publicly documented GSTR-1 JSON shape
// (gstin/fp + b2b/b2cl/b2cs/hsn) as closely as possible from here, but
// GSTN updates this schema periodically — import into the current official
// offline tool and check for validation errors before filing with it.
function downloadGstr1Json(){
  if(!gstr1Data) return;
  const gstin = (document.getElementById('bizGstin').value || '').trim();

  const b2bByCtin = {};
  gstr1Invoices.forEach(inv => {
    if(!(inv.customer && inv.customer.gstin)) return;
    const ctin = inv.customer.gstin;
    if(!b2bByCtin[ctin]) b2bByCtin[ctin] = [];
    const items = (inv.items || []).filter(li => li.productId);
    const rateGroups = {};
    items.forEach(li => {
      const key = li.gstRate;
      if(!rateGroups[key]) rateGroups[key] = { txval: 0, rt: Number(li.gstRate) };
      rateGroups[key].txval += li.taxable;
    });
    const inter = !inv.sameState;
    const itms = Object.values(rateGroups).map((r, i) => {
      const taxAmt = fix2(r.txval * r.rt / 100);
      return { num: i + 1, itm_det: { txval: fix2(r.txval), rt: r.rt, iamt: inter ? taxAmt : 0, camt: inter ? 0 : fix2(taxAmt / 2), samt: inter ? 0 : fix2(taxAmt / 2), csamt: 0 } };
    });
    b2bByCtin[ctin].push({
      inum: inv.invoiceNo, idt: ddmmyyyy(inv.date), val: fix2(inv.grandTotal),
      pos: (inv.customer.stateCode || '') + '', rchrg: inv.reverseCharge ? 'Y' : 'N', inv_typ: 'R', itms
    });
  });
  const b2b = Object.keys(b2bByCtin).map(ctin => ({ ctin, inv: b2bByCtin[ctin] }));

  const b2cl = gstr1Data.b2cl.map(row => ({
    inum: row[0], idt: ddmmyyyy(row[1]), val: row[2], pos: row[3],
    itms: [{ num: 1, itm_det: { rt: row[5], txval: row[6], iamt: fix2(row[6] * row[5] / 100), csamt: row[7] || 0 } }]
  }));

  const b2cs = gstr1Data.b2cs.map(row => ({
    typ: row[0] === 'Inter State' ? 'INTER' : 'INTRA', pos: row[1], rt: row[3], txval: row[4], csamt: row[5] || 0
  }));

  const hsn = { data: gstr1Data.hsn.map((row, i) => ({
    num: i + 1, hsn_sc: row[0], desc: row[1], uqc: row[2], qty: row[3], val: row[4],
    txval: row[6], iamt: row[7], camt: row[8], samt: row[9], csamt: row[10] || 0
  })) };

  const json = {
    gstin, fp: gstr1Data.period.replace('-', ''), version: 'GST3.0.4', hash: 'hash not computed',
    b2b, b2cl, b2cs, hsn
  };
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `GSTR1-Sales-${gstr1Data.period}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function ddmmyyyy(dateStr){
  const [y, m, d] = (dateStr || '').split('-');
  return d && m && y ? `${d}-${m}-${y}` : dateStr;
}

/* Locks every invoice and purchase behind the currently-displayed period so
   neither can be edited or deleted afterward — see deleteInvoice(),
   deletePurchase(), and renderPurchases()'s disabled Edit button. This is a
   one-way action from the UI (no "unfile" button) since un-filing should be
   a deliberate, rare correction, not a casual undo. */
async function markPeriodAsFiled(){
  if(!gstr1CurrentPeriod){ return; }
  if(!confirm(`Mark ${gstr1CurrentPeriod.label} as filed? Every invoice and purchase in this period will be locked from editing or deletion. This can't be undone from here.`)) return;

  const invoiceIds = gstr1Invoices.map(inv => inv.id).filter(Boolean);
  const purchaseIds = gstr1PurchaseRows.map(p => p.id).filter(Boolean);
  if(!invoiceIds.length && !purchaseIds.length){
    showMsg('gstrMarkFiledMsg', 'Nothing to mark — no invoices or purchases were found for this period.', false);
    return;
  }

  showMsg('gstrMarkFiledMsg', 'Marking period as filed…', true);
  try{
    const invCol = db.collection('users').doc(currentUser.uid).collection('invoices');
    const purCol = db.collection('users').doc(currentUser.uid).collection('purchases');
    const allOps = [
      ...invoiceIds.map(id => ({ ref: invCol.doc(id) })),
      ...purchaseIds.map(id => ({ ref: purCol.doc(id) }))
    ];
    // Firestore batches cap at 500 writes — chunk defensively even though a
    // small business is unlikely to file 500+ documents in one period.
    for(let i = 0; i < allOps.length; i += 400){
      const batch = db.batch();
      allOps.slice(i, i + 400).forEach(op => {
        batch.update(op.ref, {
          gstFiled: true,
          gstFiledPeriod: gstr1CurrentPeriod.label,
          gstFiledAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
      await batch.commit();
    }
    showMsg('gstrMarkFiledMsg', `Marked ${invoiceIds.length} invoice(s) and ${purchaseIds.length} purchase(s) as filed.`, true);
    await loadInvoices();
    await loadPurchases();
  }catch(err){
    console.error('Mark as filed failed:', err);
    showMsg('gstrMarkFiledMsg', `Could not mark as filed: ${err.message}`, false);
  }
}

/* ---------------- Utils ---------------- */
function fmtMoney(n){ return (n||0).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2}); }

/* ---------------- Amount in words (Indian numbering: Lakh/Crore, not Million/Billion) ----------------
   Shown live under every payment-amount field so a typo (an extra zero, a
   missing digit) is caught by eye before saving, the same way a cheque or a
   bank transfer form shows the amount in words for exactly that reason. */
function numberToWordsIndian(amount){
  amount = Math.abs(amount || 0);
  const rupees = Math.floor(amount);
  const paise = Math.round((amount - rupees) * 100);
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  function twoDigits(n){
    if(n < 20) return ones[n];
    return tens[Math.floor(n/10)] + (n % 10 ? ' ' + ones[n % 10] : '');
  }
  function threeDigits(n){
    let str = '';
    if(n >= 100){ str += ones[Math.floor(n/100)] + ' Hundred'; n %= 100; if(n) str += ' '; }
    str += twoDigits(n);
    return str;
  }
  function rupeesToWords(n){
    if(n === 0) return 'Zero';
    let remaining = n;
    const crore = Math.floor(remaining / 10000000); remaining %= 10000000;
    const lakh = Math.floor(remaining / 100000); remaining %= 100000;
    const thousand = Math.floor(remaining / 1000); remaining %= 1000;
    const hundred = remaining;
    const parts = [];
    if(crore) parts.push(threeDigits(crore) + ' Crore');
    if(lakh) parts.push(twoDigits(lakh) + ' Lakh');
    if(thousand) parts.push(twoDigits(thousand) + ' Thousand');
    if(hundred) parts.push(threeDigits(hundred));
    return parts.join(' ');
  }
  let result = rupeesToWords(rupees) + ' Rupees';
  if(paise > 0) result += ' and ' + twoDigits(paise) + ' Paise';
  return result + ' Only';
}
/* Reads a number input and writes its word form into a target element —
   pass this straight into a field's oninput, and call it once by hand
   after any place that resets or programmatically sets the field's value
   (a plain .value= assignment doesn't fire oninput on its own). */
function updateAmountWords(inputId, outputId){
  const input = document.getElementById(inputId);
  const output = document.getElementById(outputId);
  if(!input || !output) return;
  const val = parseFloat(input.value);
  output.textContent = (val && val > 0) ? numberToWordsIndian(val) : '';
}
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function showMsg(id, text, ok){
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'msg ' + (ok ? 'ok' : 'error');
}

/* Shared by every History table's From/To date filters: reads the two inputs
   and reports whether dateStr falls inside the chosen range. Blank inputs on
   either side mean "no limit" on that side. */
function dateInRange(dateStr, fromId, toId){
  const fromEl = document.getElementById(fromId), toEl = document.getElementById(toId);
  const from = fromEl ? fromEl.value : '', to = toEl ? toEl.value : '';
  if(from && dateStr < from) return false;
  if(to && dateStr > to) return false;
  return true;
}
function exportRowsToExcel(filename, headers, rows){
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, filename);
}
function exportPurchaseHistory(){
  const rows = [];
  purchasesCache
    .filter(p => dateInRange(p.date, 'purchaseHistFrom', 'purchaseHistTo'))
    .forEach(p => (p.items||[]).forEach(li => {
      rows.push([p.date, p.supplierName, li.name, li.qty, li.unit, li.total||0]);
    }));
  exportRowsToExcel('Purchase-History.xlsx', ['Date','Supplier','Product','Qty','Unit','Total (incl GST)'], rows);
}
function exportPaymentHistory(){
  const rows = paymentsCache
    .filter(p => dateInRange(p.date, 'paymentHistFrom', 'paymentHistTo'))
    .map(p => [p.date, p.supplierName, p.amount||0, p.mode||'', p.note||'']);
  exportRowsToExcel('Payment-History.xlsx', ['Date','Supplier','Amount','Mode','Note'], rows);
}
function exportStockMovements(){
  const rows = stockMovementsCache
    .filter(m => dateInRange(m.date, 'stockMoveFrom', 'stockMoveTo'))
    .map(m => [m.date, m.type, m.productName, m.qty, m.note||'']);
  exportRowsToExcel('Stock-Movements.xlsx', ['Date','Type','Product','Qty Change','Note'], rows);
}
function exportInvoiceHistory(){
  const rows = [];
  Object.values(invoicesCache)
    .filter(inv => dateInRange(inv.date||'', 'invoiceHistFrom', 'invoiceHistTo'))
    .forEach(inv => {
      const items = (inv.items||[]).filter(li => li.productId);
      (items.length ? items : [{name:'', qty:'', unit:''}]).forEach(li => {
        rows.push([inv.invoiceNo||'', inv.date||'', inv.customer?.name||'', li.name||'', li.qty||'', li.unit||'', inv.grandTotal||0, inv.emailSent ? 'Sent' : 'Not sent']);
      });
    });
  exportRowsToExcel('Invoice-History.xlsx', ['Invoice #','Date','Customer','Product','Qty','Unit','Total','Emailed'], rows);
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
