const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, loadCore, mkPdf, sleep, closeAll, A, B, C } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });

const PAGES = ['billing/portal.html', 'billing/app.html', 'billing/account.html', 'billing/complete-profile.html', 'billing/login.html', 'billing/invoice-view.html', 'billing/reset-password.html',
  'billing/seller/order-receive.html', 'billing/buyer/dashboard.html', 'billing/buyer/my-sellers.html', 'billing/buyer/place-order.html', 'billing/buyer/label-order.html', 'billing/buyer/buyer-sku-master.html',
  'billing/buyer/my-orders.html', 'billing/buyer/purchase-entry.html', 'billing/buyer/payment-entry.html', 'billing/buyer/stock.html', 'billing/buyer/purchases-gstr.html', 'billing/buyer/import-purchases.html',
  'billing/buyer/seller-products.html', 'tools/label-cropper.html', 'tools/label-studio.html', 'tools/tools-home.html', 'tools/gst-return-tool.html', 'free-services.html'];
// Libraries loaded from the internet in the real browser (not in the test browser):
const EXTERNAL = /QRCode|jsPDF|jspdf|pdfjsLib|emailjs|Not implemented|window\.open|HTMLCanvas|scrollTo|matchMedia|IntersectionObserver|navigation/i;
test('every page loads signed in, with no errors', async () => {
  await reset();
  await seed('users/' + A.uid, { email: A.email, fullName: 'Seller', businessName: 'VISUTRA', stateCode: '09', profileComplete: true, roles: { seller: true, buyer: true }, username: 'visutra' });
  await seed('users/' + B.uid, { email: B.email, fullName: 'Buyer', businessName: 'Shop', profileComplete: true, roles: { buyer: true }, username: 'shop' });
  await seed(`sellerLinks/${A.uid}_${B.uid}`, { sellerUid: A.uid, buyerUid: B.uid, sellerName: 'VISUTRA', buyerName: 'Shop', status: 'ACTIVE' });
  await seed(`users/${A.uid}/products/sp1`, { name: 'WM Cover', active: true, buyerVisibility: true, stock: 5, price: 300 });
  const failures = [];
  for(const pg of PAGES){
    const who = /\/buyer\//.test(pg) ? B : A;
    const errs = [];
    try{
      loadPage(pg, who, { before: w => {
        w.addEventListener('error', e => errs.push((e.error && e.error.message) || e.message));
        w.addEventListener('unhandledrejection', e => errs.push(String((e.reason && e.reason.message) || e.reason)));
        const ce = w.console.error.bind(w.console); w.console.error = (...a) => errs.push(a.map(x => (x && x.message) || String(x)).join(' '));
        w.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 0 }) }) };
        w.emailjs = { init(){}, send: async () => ({}) };
      } });
      await sleep(1100);
    }catch(e){ errs.push('load: ' + e.message); }
    const real = errs.filter(e => !EXTERNAL.test(e));
    if(real.length) failures.push(`${pg}: ${real.slice(0, 2).join(' | ')}`);
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});
