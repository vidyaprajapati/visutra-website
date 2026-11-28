const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { JSDOM } = require('jsdom');
function setup(side){
  const html = fs.readFileSync(path.join(__dirname, '..', 'billing', 'order-sheet.html'), 'utf8');
  const inline = html.match(/<script>\n([\s\S]*?)<\/script>/)[1].replace(/auth\.onAuthStateChanged[\s\S]*$/, '');
  const body = html.match(/<body>([\s\S]*?)<script src="https:\/\/cdn/)[1];
  const dom = new JSDOM('<body>' + body + '</body>', { runScripts: 'outside-only', url: 'https://visutra.in/billing/order-sheet.html?side=' + side });
  const w = dom.window, store = {}, log = []; w.Element.prototype.scrollIntoView = function(){};
  const inc = n => ({ __inc: n });
  function ref(p){
    return { async get(){ const v = store[p]; return { exists: !!v, id: p.split('/').pop(), data: () => v }; },
      async set(d, o){ store[p] = Object.assign((o && o.merge && store[p]) || {}, d); log.push(['set', p, d]); },
      async update(d){ const cur = store[p] || {}; Object.keys(d).forEach(k => { cur[k] = d[k] && d[k].__inc !== undefined ? (cur[k] || 0) + d[k].__inc : d[k]; }); store[p] = cur; log.push(['update', p, d]); },
      collection(n){ return coll(p + '/' + n); }, doc(id){ return ref(p + '/' + id); } };
  }
  let n = 0;
  function coll(p){ return { doc: id => ref(p + '/' + id), async add(d){ const id = 'n' + (++n); store[p + '/' + id] = d; log.push(['add', p + '/' + id, d]); return { id }; },
    async get(){ const docs = Object.keys(store).filter(k => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/')).map(k => ({ id: k.split('/').pop(), data: () => store[k] })); return { docs }; } }; }
  w.db = { collection: c => ({ doc: id => ref(c + '/' + id) }) };
  w.firebase = { firestore: { FieldValue: { serverTimestamp: () => 'TS', increment: inc } } };
  w.eval(inline.replace(/\blet (items|recips|osHist|cart|photo|linkOpts|currentUser|me|SIDE|TAB|recvId)\b/g, 'var $1').replace(/\bconst (\$|esc|col)\b/g, 'var $1'));
  return { w, store, log };
}
test('seller: receiving part of an order makes a purchase, raises linked stock, leaves shortfall', async () => {
  const { w, store, log } = setup('seller');
  w.eval("currentUser = { uid: 'U' }; SIDE = 'seller';");
  store['users/U/suppliers/S1'] = { name: 'Sup One' };
  store['users/U/products/P1'] = { stock: 5 };
  w.eval("linkOpts = [{ id: 'PP1', name: 'Cover', hsn: '6307', linkedProductId: 'P1' }];");
  store['users/U/orderSheets/H1'] = { orderNo: 'OS-1', recipientKey: 'S:S1', recipientName: 'Sup One', received: {}, lines: [{ sku: 'A', name: 'Cover', unit: 'PCS', qty: 10, link: 'PP1', rate: 100, gstRate: 18, priceMode: 'incl' }, { sku: 'B', name: 'Bag', unit: 'PCS', qty: 4, link: '', rate: 0, gstRate: 0, priceMode: 'incl' }] };
  w.eval("osHist = [{ id: 'H1', orderNo: 'OS-1', recipientKey: 'S:S1', recipientName: 'Sup One', received: {}, lines: " + JSON.stringify(store['users/U/orderSheets/H1'].lines) + " }];");
  w.eval("osLoad = async function(){}; osRenderHist = function(){}; showMsg = function(t){ window.__m = t; };");
  w.eval("osReceiveOpen('H1')");
  w.document.getElementById('rv-q0').value = '6';       // only 6 of 10 arrived
  w.document.getElementById('rv-c1').checked = false;   // B not delivered
  await w.eval("osReceiveSave()");
  const pur = Object.keys(store).find(k => k.startsWith('users/U/purchases/'));
  assert.ok(pur, 'purchase created');
  assert.strictEqual(store[pur].items.length, 1);
  assert.strictEqual(store[pur].items[0].qty, 6);
  assert.strictEqual(Math.round(store[pur].grandTotal), 600);            // 6 x 100 incl GST
  assert.strictEqual(Math.round(store[pur].gstTotal * 100) / 100, 91.53); // 600 - 600/1.18
  assert.strictEqual(store['users/U/products/P1'].stock, 11);             // 5 + 6
  assert.ok(Object.keys(store).some(k => k.startsWith('users/U/stockMovements/')));
  const h = store['users/U/orderSheets/H1'];
  assert.strictEqual(h.received.A, 6); assert.strictEqual(h.status, 'PARTIAL');
  assert.deepStrictEqual(Array.from(w.eval("osShort({lines:[{sku:'A',qty:10},{sku:'B',qty:4}],received:{A:6}})").map(x => x.sku + x.short)), ['A4', 'B4']);
});
test('buyer: receive writes buyerPurchases + buyerSkuMappings stock; complete order => RECEIVED', async () => {
  const { w, store } = setup('buyer');
  w.eval("currentUser = { uid: 'B' }; SIDE = 'buyer';");
  store['users/B/buyerSuppliers/S9'] = { name: 'Seller X' };
  store['users/B/buyerSkuMappings/M1'] = { stock: 2, productName: 'Cover' };
  const lines = [{ sku: 'A', name: 'Cover', unit: 'PCS', qty: 3, link: 'M1', rate: 50, gstRate: 12, priceMode: 'excl' }];
  store['users/B/orderSheets/H2'] = { orderNo: 'OS-2', recipientKey: 'S:S9', recipientName: 'Seller X', received: {}, lines };
  w.eval("osHist = [{ id: 'H2', orderNo: 'OS-2', recipientKey: 'S:S9', recipientName: 'Seller X', received: {}, lines: " + JSON.stringify(lines) + " }];");
  w.eval("osLoad = async function(){}; osRenderHist = function(){}; showMsg = function(){};");
  w.eval("osReceiveOpen('H2')");
  await w.eval("osReceiveSave()");
  const pur = Object.keys(store).find(k => k.startsWith('users/B/buyerPurchases/'));
  assert.strictEqual(store[pur].items[0].linkedSkuMappingId, 'M1');
  assert.strictEqual(Math.round(store[pur].grandTotal * 100) / 100, 168);   // 3*50*1.12
  assert.strictEqual(store['users/B/buyerSkuMappings/M1'].stock, 5);
  assert.strictEqual(store['users/B/orderSheets/H2'].status, 'RECEIVED');
});
test('usual items are listed first and last quantities can be filled', () => {
  const { w } = setup('seller');
  w.eval("items = [{id:'a',sku:'A1',name:'Rare',unit:'PCS'},{id:'b',sku:'B1',name:'Usual',unit:'PCS',orderCount:5,lastQty:40},{id:'c',sku:'C1',name:'Often',unit:'PCS',orderCount:2,lastQty:10}]; showMsg = function(){};");
  w.eval('osRenderPick()');
  const skus = Array.from(w.document.querySelectorAll('#osPick .sku')).map(e => e.textContent.trim().split(' ')[0]);
  assert.deepStrictEqual(skus, ['B1', 'C1', 'A1']);
  w.eval('osFillUsual()');
  assert.strictEqual(w.document.getElementById('q-b').value, '40');
  assert.match(w.document.querySelector('#osPick .os-item').textContent, /PCS/);
  assert.strictEqual(w.document.querySelectorAll('#osPick input[list]').length, 0);
  assert.strictEqual(w.document.getElementById('q-a').value, '');
  assert.match(w.document.getElementById('osSel').textContent, /2 items · total qty 50/);
});
