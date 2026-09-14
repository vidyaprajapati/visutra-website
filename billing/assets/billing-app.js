let currentUser = null;
let businessData = {};
let productsCache = [];
let purchaseProductsCache = [];
let billingMode = 'invoice';
let customersCache = [];
let suppliersCache = [];
let purchasesCache = [];
let paymentsCache = [];
let lineItems = []; // invoice items
let purchaseRows = []; // purchase rows entered together on one supplier/date/bill

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
  populateStateSelect(document.getElementById('cState')); populateStateSelect(document.getElementById('sState'));
  document.getElementById('invDate').valueAsDate = new Date();
  populateGstrFY();
  onFilingTypeChange();
  initSignaturePad();
  await loadProfile();
  await loadProducts();
  await loadPurchaseProducts();
  await loadCustomers();
  await loadSuppliers();
  await loadPurchases();
  await loadSupplierPayments();
  document.getElementById('purDate').valueAsDate = new Date();
  initPurchaseRows();
  document.getElementById('payDate').valueAsDate = new Date();
  addLineItem();
  loadInvoices();
});

function signOut(){ auth.signOut().then(()=> window.location.href = 'login.html'); }

/* ---------------- Nav / billing modes ---------------- */
function setBillingMode(mode){
  billingMode = mode;
  document.getElementById('modeInvoiceBtn').classList.toggle('active', mode === 'invoice');
  document.getElementById('modePurchaseBtn').classList.toggle('active', mode === 'purchase');
  document.querySelectorAll('[data-mode="invoice"]').forEach(el => el.classList.toggle('mode-hidden', mode !== 'invoice'));
  document.querySelectorAll('[data-mode="purchase"]').forEach(el => el.classList.toggle('mode-hidden', mode !== 'purchase'));
  const first = mode === 'invoice' ? 'products' : 'suppliers';
  const link = document.querySelector('.nav-link[data-view="'+first+'"]');
  if(link) link.click();
}

document.querySelectorAll('.nav-link').forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    if(link.dataset.mode && link.dataset.mode !== 'common' && link.dataset.mode !== billingMode) return;
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    link.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById('view-' + link.dataset.view).classList.remove('hidden');
    if(link.dataset.view === 'invoices') loadInvoices();
    if(link.dataset.view === 'purchases') { loadPurchases(); fillPurchaseProduct(); }
    if(link.dataset.view === 'payments') { loadSupplierPayments(); showSupplierBalance(); }
    if(link.dataset.view === 'supplier-ledger') loadSupplierLedger();
    if(link.dataset.view === 'suppliers') loadSuppliers();
    if(link.dataset.view === 'purchase-products') loadPurchaseProducts();
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

/* ---------------- Products ---------------- */
async function loadProducts(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('products').orderBy('name').get();
  productsCache = snap.docs.map(d => ({id:d.id, ...d.data()}));
  renderProducts();
  renderProductDropdowns();
  renderPurchaseProductDropdown();
}
function renderProducts(){
  document.getElementById('productsTable').innerHTML = productsCache.map(p => `
    <tr><td>${esc(p.name)}</td><td>${esc(p.hsn)}</td><td>${esc(p.unit)}</td><td>${p.gstRate}%</td><td>₹${fmtMoney(p.sellingPrice || 0)}</td>
    <td class="row-actions">
      <button class="btn small" onclick="editProduct('${p.id}')">Edit</button>
      <button class="btn small danger" onclick="deleteProduct('${p.id}')">Delete</button>
    </td></tr>`).join('') || '<tr><td colspan="6" style="color:var(--muted)">No products yet.</td></tr>';
}
async function saveProduct(){
  const id = document.getElementById('pEditId').value;
  const data = {
    name: document.getElementById('pName').value.trim(),
    hsn: document.getElementById('pHsn').value.trim(),
    unit: document.getElementById('pUnit').value.trim() || 'PCS',
    gstRate: parseFloat(document.getElementById('pGst').value),
    sellingPrice: parseFloat(document.getElementById('pPrice').value) || 0
  };
  if(!data.name){ showMsg('productMsg', 'Product name is required.', false); return; }
  const col = db.collection('users').doc(currentUser.uid).collection('products');
  if(id){ await col.doc(id).set(data); } else { await col.add(data); }
  ['pName','pHsn','pUnit','pPrice','pEditId'].forEach(f => document.getElementById(f).value = '');
  document.getElementById('pGst').value = '0';
  showMsg('productMsg', 'Saved.', true);
  loadProducts();
}
function editProduct(id){
  const p = productsCache.find(x => x.id === id);
  document.getElementById('pEditId').value = id;
  document.getElementById('pName').value = p.name;
  document.getElementById('pHsn').value = p.hsn;
  document.getElementById('pUnit').value = p.unit;
  document.getElementById('pGst').value = p.gstRate;
  document.getElementById('pPrice').value = p.sellingPrice ?? '';
}
async function deleteProduct(id){
  if(!confirm('Delete this product?')) return;
  await db.collection('users').doc(currentUser.uid).collection('products').doc(id).delete();
  loadProducts();
}


/* ---------------- Suppliers ---------------- */
async function loadSuppliers(){
  const snap = await db.collection('users').doc(currentUser.uid).collection('suppliers').orderBy('name').get();
  suppliersCache = snap.docs.map(d => ({id:d.id, ...d.data()}));
  renderSuppliers();
  renderSupplierDropdowns();
}
function renderSuppliers(){
  const el = document.getElementById('suppliersTable');
  if(!el) return;
  el.innerHTML = suppliersCache.map(s => `<tr>
    <td>${esc(s.name)}</td><td>${esc(s.gstin||'—')}</td><td>${esc(s.state||'')}</td><td>${esc(s.phone||'')}</td>
    <td class="row-actions"><button class="btn small" onclick="editSupplier('${s.id}')">Edit</button>
    <button class="btn small danger" onclick="deleteSupplier('${s.id}')">Delete</button></td></tr>`).join('') ||
    '<tr><td colspan="5" style="color:var(--muted)">No suppliers yet.</td></tr>';
}
function supplierOptions(placeholder){
  return `<option value="">${placeholder}</option>` + suppliersCache.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
}
function renderSupplierDropdowns(){
  ['purSupplier','paySupplier','ledgerSupplier','purchaseHistorySupplier'].forEach(id=>{
    const el=document.getElementById(id); if(!el) return;
    const old=el.value;
    const ph = id==='purchaseHistorySupplier' ? 'All suppliers' : 'Select supplier…';
    el.innerHTML=supplierOptions(ph);
    if(old && suppliersCache.some(s=>s.id===old)) el.value=old;
  });
  renderPurchaseProductDropdown();
}
async function saveSupplier(){
  const id=document.getElementById('sEditId').value;
  const stateCode=document.getElementById('sState').value;
  const data={
    name:document.getElementById('sName').value.trim(),
    gstin:document.getElementById('sGstin').value.trim(),
    address:document.getElementById('sAddress').value.trim(),
    stateCode, state:stateNameByCode(stateCode),
    phone:document.getElementById('sPhone').value.trim(),
    email:document.getElementById('sEmail').value.trim()
  };
  if(!data.name){showMsg('supplierMsg','Supplier name is required.',false);return;}
  const col=db.collection('users').doc(currentUser.uid).collection('suppliers');
  if(id) await col.doc(id).set(data,{merge:true}); else await col.add(data);
  ['sName','sGstin','sAddress','sPhone','sEmail','sEditId'].forEach(x=>document.getElementById(x).value='');
  document.getElementById('sState').value='';
  showMsg('supplierMsg','Supplier saved.',true);
  await loadSuppliers();
}
function editSupplier(id){
  const s=suppliersCache.find(x=>x.id===id); if(!s)return;
  document.getElementById('sEditId').value=id;
  document.getElementById('sName').value=s.name||'';
  document.getElementById('sGstin').value=s.gstin||'';
  document.getElementById('sAddress').value=s.address||'';
  document.getElementById('sState').value=s.stateCode||'';
  document.getElementById('sPhone').value=s.phone||'';
  document.getElementById('sEmail').value=s.email||'';
}
async function deleteSupplier(id){
  if(!confirm('Delete this supplier? Existing purchase/payment records will remain.'))return;
  await db.collection('users').doc(currentUser.uid).collection('suppliers').doc(id).delete();
  await loadSuppliers();
}
function renderPurchaseProductDropdown(){
  const el=document.getElementById('purProduct'); if(!el)return;
  const old=el.value;
  el.innerHTML='<option value="">Select purchase product…</option>'+purchaseProductsCache.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('');
  if(old && purchaseProductsCache.some(p=>p.id===old)) el.value=old;
}
async function loadPurchaseProducts(){
  if(!currentUser)return;
  const snap=await db.collection('users').doc(currentUser.uid).collection('purchaseProducts').orderBy('name').get();
  purchaseProductsCache=snap.docs.map(d=>({id:d.id,...d.data()}));
  renderPurchaseProducts();
  renderPurchaseProductDropdown();
}
function renderPurchaseProducts(){
  const el=document.getElementById('purchaseProductsTable'); if(!el)return;
  el.innerHTML=purchaseProductsCache.map(p=>`<tr><td>${esc(p.name)}</td><td>${esc(p.hsn||'')}</td><td>${esc(p.unit||'')}</td><td>${p.gstRate||0}%</td><td class="row-actions"><button class="btn small" onclick="editPurchaseProduct('${p.id}')">Edit</button><button class="btn small danger" onclick="deletePurchaseProduct('${p.id}')">Delete</button></td></tr>`).join('')||'<tr><td colspan="5" style="color:var(--muted)">No purchase products yet.</td></tr>';
}
async function savePurchaseProduct(){
  const id=document.getElementById('ppEditId').value;
  const data={name:document.getElementById('ppName').value.trim(),hsn:document.getElementById('ppHsn').value.trim(),unit:document.getElementById('ppUnit').value.trim()||'PCS',gstRate:parseFloat(document.getElementById('ppGst').value)||0};
  if(!data.name){showMsg('purchaseProductMsg','Product name is required.',false);return;}
  const col=db.collection('users').doc(currentUser.uid).collection('purchaseProducts');
  if(id) await col.doc(id).set(data); else await col.add(data);
  ['ppName','ppHsn','ppUnit','ppEditId'].forEach(x=>document.getElementById(x).value=''); document.getElementById('ppGst').value='0';
  showMsg('purchaseProductMsg','Purchase product saved.',true); await loadPurchaseProducts();
}
function editPurchaseProduct(id){const p=purchaseProductsCache.find(x=>x.id===id);if(!p)return;document.getElementById('ppEditId').value=id;document.getElementById('ppName').value=p.name||'';document.getElementById('ppHsn').value=p.hsn||'';document.getElementById('ppUnit').value=p.unit||'';document.getElementById('ppGst').value=p.gstRate||0;}
async function deletePurchaseProduct(id){if(!confirm('Delete this purchase product? Existing purchase records will remain.'))return;await db.collection('users').doc(currentUser.uid).collection('purchaseProducts').doc(id).delete();await loadPurchaseProducts();}

function initPurchaseRows(){
  purchaseRows=[];
  addPurchaseRow();
}
function addPurchaseRow(){
  const id=Date.now()+Math.random();
  purchaseRows.push({id,productId:'',qty:1,rate:'',gst:0,unit:'',lastPrice:''});
  renderPurchaseEntryRows();
}
function removePurchaseRow(index){
  if(purchaseRows.length===1){
    purchaseRows[0]={...purchaseRows[0],productId:'',qty:1,rate:'',gst:0,unit:'',lastPrice:''};
  } else purchaseRows.splice(index,1);
  renderPurchaseEntryRows();
  refreshPurchaseTotals();
}
function renderPurchaseEntryRows(){
  const el=document.getElementById('purchaseItemsBody'); if(!el)return;
  el.innerHTML=purchaseRows.map((r,i)=>`<tr>
    <td><select class="pur-row-product" onchange="setPurchaseRowProduct(${i},this.value)"><option value="">Select product…</option>${purchaseProductsCache.map(p=>`<option value="${p.id}" ${p.id===r.productId?'selected':''}>${esc(p.name)}</option>`).join('')}</select><small id="pur-last-${i}" class="sub purchase-last-price">${r.lastPrice||''}</small></td>
    <td><input type="number" min="0" step="0.001" value="${r.qty}" oninput="purchaseRowField(${i},'qty',this.value)"></td>
    <td><input disabled value="${esc(r.unit||'')}"></td>
    <td><input type="number" min="0" step="0.01" value="${r.rate}" oninput="purchaseRowField(${i},'rate',this.value)"></td>
    <td><select onchange="purchaseRowField(${i},'gst',this.value)"><option value="0" ${Number(r.gst)===0?'selected':''}>0%</option><option value="5" ${Number(r.gst)===5?'selected':''}>5%</option><option value="12" ${Number(r.gst)===12?'selected':''}>12%</option><option value="18" ${Number(r.gst)===18?'selected':''}>18%</option><option value="28" ${Number(r.gst)===28?'selected':''}>28%</option></select></td>
    <td id="pur-gst-${i}">₹0.00</td><td id="pur-total-${i}"><b>₹0.00</b></td>
    <td><button class="btn small danger" type="button" onclick="removePurchaseRow(${i})">Remove</button></td>
  </tr>`).join('');
  purchaseRows.forEach((_,i)=>updatePurchaseRowTotal(i));
}
async function setPurchaseRowProduct(index,productId){
  const row=purchaseRows[index]; if(!row)return;
  row.productId=productId; row.lastPrice='';
  const p=purchaseProductsCache.find(x=>x.id===productId);
  if(!p){row.unit='';row.rate='';row.gst=0;renderPurchaseEntryRows();refreshPurchaseTotals();return;}
  row.unit=p.unit||'PCS'; row.gst=(p.gstRate ?? 0);
  const supplierId=document.getElementById('purSupplier').value;
  if(supplierId){
    try{
      const key=supplierId+'__'+productId;
      const snap=await db.collection('users').doc(currentUser.uid).collection('supplierProductPrices').doc(key).get();
      if(snap.exists && snap.data().lastPurchaseRate != null){
        const d=snap.data(); row.rate=d.lastPurchaseRate;
        row.lastPrice='Last price: ₹'+fmtMoney(d.lastPurchaseRate)+(d.lastPurchaseDate?' on '+d.lastPurchaseDate:'');
      } else row.lastPrice='No previous price for this supplier and product.';
    }catch(e){console.error(e);}
  }
  renderPurchaseEntryRows(); refreshPurchaseTotals();
}
function purchaseRowField(index,field,value){
  const row=purchaseRows[index]; if(!row)return;
  row[field]=field==='qty'||field==='rate'||field==='gst' ? Number(value) : value;
  updatePurchaseRowTotal(index); refreshPurchaseTotals();
}
function updatePurchaseRowTotal(index){
  const r=purchaseRows[index]||{};
  const qty=Number(r.qty)||0, rate=Number(r.rate)||0, gst=Number(r.gst)||0;
  const taxable=qty*rate, gstAmt=taxable*gst/100, total=taxable+gstAmt;
  const g=document.getElementById('pur-gst-'+index), t=document.getElementById('pur-total-'+index);
  if(g)g.textContent='₹'+fmtMoney(gstAmt);
  if(t)t.innerHTML='<b>₹'+fmtMoney(total)+'</b>';
  return {qty,rate,gst,taxable,gstAmt,total,unitFinal:rate*(1+gst/100)};
}
function refreshPurchaseTotals(){
  let taxable=0,gst=0,total=0;
  purchaseRows.forEach((_,i)=>{const c=updatePurchaseRowTotal(i);taxable+=c.taxable;gst+=c.gstAmt;total+=c.total;});
  const a=document.getElementById('purBatchTaxable'),b=document.getElementById('purBatchGst'),c=document.getElementById('purBatchGrand');
  if(a)a.textContent='₹'+fmtMoney(taxable); if(b)b.textContent='₹'+fmtMoney(gst); if(c)c.textContent='₹'+fmtMoney(total);
  return {taxable,gst,total};
}
async function refreshAllPurchaseRows(){
  const supplierId=document.getElementById('purSupplier').value;
  for(let i=0;i<purchaseRows.length;i++){
    const r=purchaseRows[i]; if(!r.productId||!supplierId)continue;
    try{
      const key=supplierId+'__'+r.productId;
      const snap=await db.collection('users').doc(currentUser.uid).collection('supplierProductPrices').doc(key).get();
      if(snap.exists&&snap.data().lastPurchaseRate!=null){const d=snap.data();r.rate=d.lastPurchaseRate;r.lastPrice='Last price: ₹'+fmtMoney(d.lastPurchaseRate)+(d.lastPurchaseDate?' on '+d.lastPurchaseDate:'');}
      else {r.rate='';r.lastPrice='No previous price for this supplier and product.';}
    }catch(e){console.error(e);}
  }
  renderPurchaseEntryRows(); refreshPurchaseTotals();
}
async function savePurchaseBatch(){
  const supplierId=document.getElementById('purSupplier').value;
  const supplier=suppliersCache.find(s=>s.id===supplierId);
  if(!supplier){showMsg('purchaseMsg','Select a supplier.',false);return;}
  const valid=purchaseRows.filter(r=>r.productId);
  if(!valid.length){showMsg('purchaseMsg','Add at least one product.',false);return;}
  const date=document.getElementById('purDate').value||new Date().toISOString().slice(0,10);
  const billNo=document.getElementById('purBillNo').value.trim();
  const notes=document.getElementById('purNotes').value.trim();
  const batchId='PUR-'+Date.now();
  const batchTotals=refreshPurchaseTotals();
  const batchItems=[];
  try{
    for(let i=0;i<valid.length;i++){
      const r=valid[i], product=purchaseProductsCache.find(p=>p.id===r.productId), c=updatePurchaseRowTotal(purchaseRows.indexOf(r));
      if(!product||c.qty<=0||c.rate<0)throw new Error('Enter valid quantity and price for '+(product?.name||'product'));
      const data={date,supplierId,supplierName:supplier.name,productId:product.id,productName:product.name,unit:r.unit||product.unit||'PCS',qty:c.qty,unitPrice:c.rate,gstRate:c.gst,taxable:c.taxable,gstAmount:c.gstAmt,total:c.total,unitPriceInclGst:c.unitFinal,billNo,notes,batchId,batchItem:i+1,batchItemCount:valid.length,createdAt:firebase.firestore.FieldValue.serverTimestamp()};
      await db.collection('users').doc(currentUser.uid).collection('purchases').add(data); batchItems.push(data);
      const priceKey=supplierId+'__'+product.id;
      await db.collection('users').doc(currentUser.uid).collection('supplierProductPrices').doc(priceKey).set({supplierId,supplierName:supplier.name,productId:product.id,productName:product.name,lastPurchaseRate:c.rate,lastPurchaseDate:date,lastPurchaseGstRate:c.gst,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
    }
    showMsg('purchaseMsg',`${valid.length} purchase item${valid.length>1?'s':''} saved together. Total including GST: ₹${fmtMoney(batchTotals.total)}`,true);
    document.getElementById('purBillNo').value=''; document.getElementById('purNotes').value='';
    purchaseRows=[]; addPurchaseRow(); await loadPurchases();
  }catch(e){console.error(e);showMsg('purchaseMsg','Purchase could not be saved: '+e.message,false);}
}
function clearPurchaseForm(){
  document.getElementById('purBillNo').value='';document.getElementById('purNotes').value='';
  purchaseRows=[];addPurchaseRow();
}

async function loadPurchases(){
  if(!currentUser)return;
  const snap=await db.collection('users').doc(currentUser.uid).collection('purchases').orderBy('date','desc').limit(500).get();
  purchasesCache=snap.docs.map(d=>({id:d.id,...d.data()}));
  renderPurchaseHistory();
  if(document.getElementById('ledgerSupplier')) loadSupplierLedger();
}
function inDateRange(item,from,to){
  if(from && item.date<from)return false;
  if(to && item.date>to)return false;
  return true;
}
function renderPurchaseHistory(){
  const el=document.getElementById('purchasesTable'); if(!el)return;
  const sid=document.getElementById('purchaseHistorySupplier')?.value||'';
  const from=document.getElementById('purchaseHistoryFrom')?.value||'', to=document.getElementById('purchaseHistoryTo')?.value||'';
  const rows=purchasesCache.filter(p=>(!sid||p.supplierId===sid)&&inDateRange(p,from,to)).map(p=>
    `<tr><td>${esc(p.date||'')}</td><td>${esc(p.supplierName||'')}</td><td>${esc(p.productName||'')}</td>
    <td>${p.qty}</td><td>₹${fmtMoney(p.unitPriceInclGst||0)}</td><td>₹${fmtMoney(p.gstAmount||0)} (${p.gstRate||0}%)</td>
    <td><b>₹${fmtMoney(p.total||0)}</b></td><td>${esc(p.billNo||'—')}</td><td><button class="btn small" onclick="downloadPurchaseVoucher('${p.id}')">PDF</button></td></tr>`).join('');
  el.innerHTML=rows||'<tr><td colspan="9" style="color:var(--muted)">No purchases found.</td></tr>';
}
async function loadSupplierPayments(){
  if(!currentUser)return;
  const snap=await db.collection('users').doc(currentUser.uid).collection('supplierPayments').orderBy('date','desc').limit(500).get();
  paymentsCache=snap.docs.map(d=>({id:d.id,...d.data()}));
  renderPayments();
  showSupplierBalance();
}
function renderPayments(){
  const el=document.getElementById('paymentsTable'); if(!el)return;
  const rows=paymentsCache.map(p=>`<tr><td>${esc(p.date||'')}</td><td>${esc(p.supplierName||'')}</td>
    <td><b>₹${fmtMoney(p.amount||0)}</b></td><td>${esc(p.method||'')}</td><td>${esc(p.reference||'—')}</td><td>${esc(p.notes||'')}</td></tr>`).join('');
  el.innerHTML=rows||'<tr><td colspan="6" style="color:var(--muted)">No payments yet.</td></tr>';
}
function supplierTotals(supplierId,from='',to=''){
  const purchases=purchasesCache.filter(p=>p.supplierId===supplierId&&inDateRange(p,from,to));
  const pays=paymentsCache.filter(p=>p.supplierId===supplierId&&inDateRange(p,from,to));
  const purchaseTotal=purchases.reduce((a,p)=>a+(Number(p.total)||0),0);
  const paymentTotal=pays.reduce((a,p)=>a+(Number(p.amount)||0),0);
  return {purchases,pays,purchaseTotal,paymentTotal,balance:purchaseTotal-paymentTotal};
}
function showSupplierBalance(){
  const id=document.getElementById('paySupplier')?.value;
  const el=document.getElementById('paymentBalanceBox'); if(!el)return;
  if(!id){el.textContent='Supplier balance: ₹0.00';return;}
  const t=supplierTotals(id);
  el.textContent='Current supplier balance: ₹'+fmtMoney(t.balance)+'  |  Total purchases: ₹'+fmtMoney(t.purchaseTotal)+'  |  Total payments: ₹'+fmtMoney(t.paymentTotal);
}
async function saveSupplierPayment(){
  const id=document.getElementById('paySupplier').value, s=suppliersCache.find(x=>x.id===id);
  const amount=parseFloat(document.getElementById('payAmount').value)||0;
  if(!s){showMsg('paymentMsg','Select a supplier.',false);return;}
  if(amount<=0){showMsg('paymentMsg','Enter a payment amount greater than zero.',false);return;}
  const data={
    date:document.getElementById('payDate').value||new Date().toISOString().slice(0,10),
    supplierId:id,supplierName:s.name,amount,
    method:document.getElementById('payMethod').value,
    reference:document.getElementById('payReference').value.trim(),
    notes:document.getElementById('payNotes').value.trim(),
    createdAt:firebase.firestore.FieldValue.serverTimestamp()
  };
  await db.collection('users').doc(currentUser.uid).collection('supplierPayments').add(data);
  document.getElementById('payAmount').value='';document.getElementById('payReference').value='';document.getElementById('payNotes').value='';
  showMsg('paymentMsg','Payment saved: ₹'+fmtMoney(amount),true);
  await loadSupplierPayments();
}
async function loadSupplierLedger(){
  const id=document.getElementById('ledgerSupplier')?.value;
  if(!id){
    ['ledgerPurchaseTotal','ledgerPaymentTotal','ledgerBalance'].forEach(x=>document.getElementById(x).textContent='₹0.00');
    document.getElementById('ledgerPurchasesTable').innerHTML='<tr><td colspan="8" style="color:var(--muted)">Select a supplier.</td></tr>';
    document.getElementById('ledgerPaymentsTable').innerHTML='<tr><td colspan="5" style="color:var(--muted)">Select a supplier.</td></tr>';
    return;
  }
  const from=document.getElementById('ledgerFrom').value||'',to=document.getElementById('ledgerTo').value||'';
  const t=supplierTotals(id,from,to);
  document.getElementById('ledgerPurchaseTotal').textContent='₹'+fmtMoney(t.purchaseTotal);
  document.getElementById('ledgerPaymentTotal').textContent='₹'+fmtMoney(t.paymentTotal);
  document.getElementById('ledgerBalance').textContent='₹'+fmtMoney(t.balance);
  document.getElementById('ledgerPurchasesTable').innerHTML=t.purchases.map(p=>`<tr>
    <td>${esc(p.date||'')}</td><td>${esc(p.productName||'')}</td><td>${p.qty}</td><td>${esc(p.unit||'')}</td>
    <td>₹${fmtMoney(p.unitPriceInclGst||0)}</td><td>${p.gstRate||0}% / ₹${fmtMoney(p.gstAmount||0)}</td>
    <td><b>₹${fmtMoney(p.total||0)}</b></td><td>${esc(p.billNo||'—')}</td></tr>`).join('')||
    '<tr><td colspan="8" style="color:var(--muted)">No purchases for this selection.</td></tr>';
  document.getElementById('ledgerPaymentsTable').innerHTML=t.pays.map(p=>`<tr>
    <td>${esc(p.date||'')}</td><td><b>₹${fmtMoney(p.amount||0)}</b></td><td>${esc(p.method||'')}</td>
    <td>${esc(p.reference||'—')}</td><td>${esc(p.notes||'')}</td></tr>`).join('')||
    '<tr><td colspan="5" style="color:var(--muted)">No payments for this selection.</td></tr>';
}


/* ---------------- Purchase / supplier exports ---------------- */
function pdfDoc(title, subtitle){
  const {jsPDF}=window.jspdf;
  const doc=new jsPDF({unit:'mm',format:'a4'});
  doc.setFontSize(18); doc.text(title,14,18);
  doc.setFontSize(9); doc.setTextColor(100); doc.text(subtitle||'',14,25);
  doc.setTextColor(20); return doc;
}
function downloadPurchaseVoucher(id){
  const p=purchasesCache.find(x=>x.id===id); if(!p)return;
  const s=suppliersCache.find(x=>x.id===p.supplierId)||{};
  const doc=pdfDoc('Purchase Voucher', `${p.date||''}  |  ${p.billNo ? 'Bill: '+p.billNo : 'Purchase entry'}`);
  doc.setFontSize(11); doc.text('Supplier: '+(p.supplierName||s.name||''),14,34);
  if(s.gstin) doc.text('GSTIN: '+s.gstin,14,40);
  if(s.address) doc.text('Address: '+s.address,14,46,{maxWidth:180});
  doc.autoTable({startY:53,head:[['Product','Qty','Unit','Unit Price','GST','GST Amount','Final Amount']],body:[[
    p.productName||'', String(p.qty||0), p.unit||'', '₹'+fmtMoney(p.unitPrice||0),
    (p.gstRate||0)+'%', '₹'+fmtMoney(p.gstAmount||0), '₹'+fmtMoney(p.total||0)
  ]]});
  let y=doc.lastAutoTable.finalY+10;
  doc.setFontSize(10); doc.text('Taxable value: ₹'+fmtMoney(p.taxable||0),14,y); y+=6;
  doc.text('GST amount: ₹'+fmtMoney(p.gstAmount||0),14,y); y+=6;
  doc.setFontSize(12); doc.text('Total purchase including GST: ₹'+fmtMoney(p.total||0),14,y);
  if(p.notes){y+=10;doc.setFontSize(9);doc.text('Notes: '+p.notes,14,y,{maxWidth:180});}
  doc.setFontSize(8); doc.setTextColor(100); doc.text('Generated from VISUTRA Billing',14,287);
  doc.save('purchase-voucher-'+(p.date||'purchase')+'.pdf');
}
function selectedLedgerData(){
  const id=document.getElementById('ledgerSupplier')?.value;
  if(!id)return null;
  const from=document.getElementById('ledgerFrom')?.value||'',to=document.getElementById('ledgerTo')?.value||'';
  const supplier=suppliersCache.find(s=>s.id===id)||{};
  return {id,supplier,from,to,...supplierTotals(id,from,to)};
}
function downloadSupplierStatement(){
  const d=selectedLedgerData(); if(!d){alert('Select a supplier first.');return;}
  const doc=pdfDoc('Supplier Statement', `${d.supplier.name||''}  |  ${d.from||'All dates'} to ${d.to||'All dates'}`);
  doc.setFontSize(10); doc.text('Supplier: '+(d.supplier.name||''),14,34);
  if(d.supplier.gstin) doc.text('GSTIN: '+d.supplier.gstin,14,40);
  doc.autoTable({startY:47,head:[['Date','Product','Qty','Unit','Unit Price','GST','Total','Bill No.']],body:d.purchases.map(p=>[
    p.date||'',p.productName||'',String(p.qty||0),p.unit||'', '₹'+fmtMoney(p.unitPriceInclGst||0),
    (p.gstRate||0)+'% / ₹'+fmtMoney(p.gstAmount||0),'₹'+fmtMoney(p.total||0),p.billNo||'—'
  ])});
  let y=(doc.lastAutoTable?.finalY||47)+8;
  doc.autoTable({startY:y,head:[['Payment Date','Amount','Method','Reference','Notes']],body:d.pays.map(p=>[
    p.date||'','₹'+fmtMoney(p.amount||0),p.method||'',p.reference||'—',p.notes||''
  ])});
  y=(doc.lastAutoTable?.finalY||y)+10;
  doc.setFontSize(10); doc.text('Total purchases: ₹'+fmtMoney(d.purchaseTotal),14,y); y+=6;
  doc.text('Total payments: ₹'+fmtMoney(d.paymentTotal),14,y); y+=7;
  doc.setFontSize(13); doc.text('Balance payable: ₹'+fmtMoney(d.balance),14,y);
  doc.setFontSize(8); doc.setTextColor(100); doc.text('Generated from VISUTRA Billing',14,287);
  doc.save('supplier-statement-'+((d.supplier.name||'supplier').replace(/[^a-z0-9]+/gi,'-'))+'.pdf');
}
function downloadXlsx(filename, sheets){
  if(typeof XLSX==='undefined'){alert('Excel export library could not be loaded. Please refresh the page and try again.');return;}
  const wb=XLSX.utils.book_new();
  Object.entries(sheets).forEach(([name,rows])=>XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),name.slice(0,31)));
  XLSX.writeFile(wb,filename);
}
function exportPurchasesExcel(){
  const sid=document.getElementById('purchaseHistorySupplier')?.value||'',from=document.getElementById('purchaseHistoryFrom')?.value||'',to=document.getElementById('purchaseHistoryTo')?.value||'';
  const rows=purchasesCache.filter(p=>(!sid||p.supplierId===sid)&&inDateRange(p,from,to)).map(p=>({
    Date:p.date||'',Supplier:p.supplierName||'',Product:p.productName||'',Quantity:Number(p.qty)||0,Unit:p.unit||'',
    'Unit Price Before GST':Number(p.unitPrice)||0,'GST Rate %':Number(p.gstRate)||0,'Taxable Value':Number(p.taxable)||0,
    'GST Amount':Number(p.gstAmount)||0,'Unit Price Including GST':Number(p.unitPriceInclGst)||0,'Final Purchase Price':Number(p.total)||0,'Bill No.':p.billNo||'',Notes:p.notes||''
  }));
  downloadXlsx('VISUTRA-Purchase-Register.xlsx',{Purchases:rows});
}
function exportPaymentsExcel(){
  const rows=paymentsCache.map(p=>({Date:p.date||'',Supplier:p.supplierName||'',Amount:Number(p.amount)||0,Method:p.method||'',Reference:p.reference||'',Notes:p.notes||''}));
  downloadXlsx('VISUTRA-Supplier-Payments.xlsx',{Payments:rows});
}
function exportSupplierLedgerExcel(){
  const d=selectedLedgerData(); if(!d){alert('Select a supplier first.');return;}
  const purchases=d.purchases.map(p=>({Date:p.date||'',Supplier:p.supplierName||d.supplier.name||'',Product:p.productName||'',Quantity:Number(p.qty)||0,Unit:p.unit||'',
    'Unit Price Including GST':Number(p.unitPriceInclGst)||0,'GST Rate %':Number(p.gstRate)||0,'GST Amount':Number(p.gstAmount)||0,'Final Purchase':Number(p.total)||0,'Bill No.':p.billNo||''}));
  const payments=d.pays.map(p=>({Date:p.date||'',Supplier:p.supplierName||d.supplier.name||'',Payment:Number(p.amount)||0,Method:p.method||'',Reference:p.reference||'',Notes:p.notes||''}));
  const summary=[{Supplier:d.supplier.name||'',From:d.from||'All',To:d.to||'All','Total Purchases':d.purchaseTotal,'Total Payments':d.paymentTotal,'Balance Payable':d.balance}];
  downloadXlsx('VISUTRA-'+((d.supplier.name||'Supplier').replace(/[^a-z0-9]+/gi,'-'))+'-Ledger.xlsx',{Summary:summary,Purchases:purchases,Payments:payments});
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
  lineItems[idx] = { productId, name:p.name, hsn:p.hsn, unit:p.unit, qty:lineItems[idx].qty||1, rate:Number(p.sellingPrice)||0, discount:0, gstRate:p.gstRate };
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
