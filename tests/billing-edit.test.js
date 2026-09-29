const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, loadCore, mkPdf, sleep, closeAll, A, B, C } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });

async function seedSeller(){
  await reset();
  const U = 'users/' + A.uid;
  await seed(U, { businessName: 'VISUTRA', gstin: '09BVHPP4321G1ZJ', stateCode: '09', profileComplete: true, roles: { seller: true } });
  return U;
}
test('Edit purchase opens exactly as saved; saving unchanged keeps everything', async () => {
  const U = await seedSeller();
  await seed(U + '/suppliers/s1', { name: 'Textile Co', gstin: '09AABCT1234F1Z5', stateCode: '09', openingBalance: 5000 });
  await seed(U + '/purchaseProducts/pp1', { name: 'Fabric', hsn: '5208', unit: 'MTR' });
  await seed(U + '/purchaseProducts/pp2', { name: 'Zip', hsn: '9607', unit: 'PCS' });
  await seed(U + '/purchases/pu1', { supplierId: 's1', supplierName: 'Textile Co', date: '2026-09-03', invoiceNo: 'TC/0045', gstFiled: true, gstFiledPeriod: '2026-09',
    subtotal: 2500, gstTotal: 825, grandTotal: 3325, items: [
      { productId: 'pp1', name: 'Fabric', unit: 'MTR', qty: 10, rate: 200, gstRate: 40, priceMode: 'excl', hsn: '5208', taxable: 2000, gstAmt: 800, total: 2800 },
      { productId: 'pp2', name: 'Zip', unit: 'PCS', qty: 5, rate: 105, gstRate: 5, priceMode: 'incl', hsn: '9607', taxable: 500, gstAmt: 25, total: 525 }] });
  await seed(U + '/products/p1', { name: 'WM Cover', hsn: '63079090', unit: 'PCS', price: 250, gstRate: 40, stock: 10, active: true, buyerVisibility: true, sku: 'VST-1' });
  const { w, $ } = loadPage('billing/app.html', A, { hook: 'window.__lines=()=>purchaseLineItems;' }); await sleep(1800);
  w.eval("editPurchase('pu1')"); await sleep(200);
  assert.deepEqual(w.__lines().map(l => [l.gstRate, l.priceMode]), [[40, 'excl'], [5, 'incl']]);
  assert.equal($('purInvoiceNo').value, 'TC/0045');
  assert.match($('purchaseTotalsBox').textContent.replace(/\s+/g, ' '), /2,500\.00.*825\.00.*3,325\.00/);
  await w.eval('savePurchase()'); await sleep(400);
  const after = await read(U + '/purchases/pu1');
  assert.deepEqual([after.subtotal, after.gstTotal, after.grandTotal, after.invoiceNo, after.gstFiled], [2500, 825, 3325, 'TC/0045', true]);
  // product edit must never rewrite stock from the page's old copy
  w.eval("editProduct('p1')"); await sleep(100);
  assert.equal($('pGst').value, '40');
  await pool.query("update docs set data = jsonb_set(data, '{stock}', '7') where path = $1", [U + '/products/p1']);
  $('pName').value = 'WM Cover 7kg'; await w.eval('saveProduct()'); await sleep(300);
  const p = await read(U + '/products/p1');
  assert.deepEqual([p.name, p.stock, p.gstRate, p.buyerVisibility, p.sku], ['WM Cover 7kg', 7, 40, true, 'VST-1']);
  w.eval("editSupplier('s1')"); await sleep(100); $('sPhone').value = '9999999999'; await w.eval('saveSupplier()'); await sleep(300);
  assert.equal((await read(U + '/suppliers/s1')).openingBalance, 5000, 'supplier edit keeps other fields');
});

test('Billing remembers the section across a refresh', async () => {
  await seedSeller();
  const active = w => { const a = w.document.querySelector('.nav-link.active'); return a && a.dataset.view; };
  const p = loadPage('billing/app.html', A); await sleep(1500);
  p.w.eval("activateView('stock')");
  assert.match(p.w.location.href, /#stock$/);
  for(const v of ['stock', 'invoices', 'gstr1']){
    const r = loadPage('billing/app.html', A, { query: '#' + v }); await sleep(1300);
    assert.equal(active(r.w), v);
  }
  const d = loadPage('billing/app.html', A, { query: '?view=purchases' }); await sleep(1300);
  assert.equal(active(d.w), 'purchases', 'old ?view= links still work');
});
