// Supplier access: a supplier signs in with the email a seller put on the supplier card and
// sees ONLY their own purchases / payments / balance. Real SQL (RLS + functions), real pages.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A, B, C } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });

const U = 'users/' + A.uid;
const RAJ = { uid: '11111111-0000-0000-0000-000000000001', email: 'raj@fabrics.com' };
async function world(){
  await reset();
  await pool.query('truncate public.account_approvals; truncate auth.users');
  await seed(U, { email: A.email, businessName: 'Seller A Traders', profileComplete: true, stateCode: '09' });
  await seed('users/' + B.uid, { email: B.email, businessName: 'Seller B Co', profileComplete: true });
  await seed(U + '/suppliers/s1', { name: 'Raj Fabrics', email: 'Raj@Fabrics.com ', phone: '9990001111' });
  await seed(U + '/suppliers/s2', { name: 'Other Supplier', email: 'other@x.com' });
  await seed('users/' + B.uid + '/suppliers/s9', { name: 'Raj Fabrics (B)', email: 'raj@fabrics.com' });
  await seed(U + '/purchases/p1', { supplierId: 's1', date: '2026-10-01', invoiceNo: 'INV-1', subtotal: 1000, gstTotal: 180, grandTotal: 1180, linkedProductId: 'SECRETPROD',
    items: [{ name: 'Cloth roll', qty: 10, unit: 'MTR', rate: 100, gstRate: 18, priceMode: 'excl', total: 1180, linkedProductId: 'SECRETPROD' }] });
  await seed(U + '/purchases/p2', { supplierId: 's1', date: '2026-10-05', grandTotal: 500, items: [] });
  await seed(U + '/purchases/p3', { supplierId: 's1', date: '2026-10-06', grandTotal: 9999, deleted: true, items: [] });
  await seed(U + '/purchases/p4', { supplierId: 's2', date: '2026-10-06', grandTotal: 7777, items: [] });
  await seed(U + '/payments/y1', { supplierId: 's1', date: '2026-10-02', amount: 600, mode: 'UPI', note: 'advance' });
  await seed(U + '/payments/y2', { supplierId: 's1', date: '2026-10-03', amount: 50, deleted: true });
  await seed(U + '/payments/y3', { supplierId: 's2', date: '2026-10-03', amount: 4242 });
  await seed('users/' + B.uid + '/purchases/q1', { supplierId: 's9', date: '2026-10-07', grandTotal: 300, items: [] });
}
const text = pg => pg.w.document.body.textContent.replace(/\s+/g, ' ');

test('supplier dashboard shows only their own purchases, payments and balance', async () => {
  await world();
  const pg = loadPage('billing/supplier/dashboard.html', RAJ);
  await sleep(1500);
  const t = text(pg);
  assert.match(t, /Seller A Traders/); assert.match(t, /Seller B Co/);
  assert.match(t, /₹1,680\.00/, 'A: purchases 1180+500');
  assert.match(t, /₹600\.00/, 'A: paid');
  assert.match(t, /₹1,080\.00/, 'A: balance 1680-600');
  assert.match(t, /₹300\.00/, 'B: balance');
  assert.match(t, /INV-1/); assert.match(t, /Cloth roll/); assert.match(t, /advance/);
  for (const secret of ['Other Supplier', '7,777', '4,242', '9,999', 'SECRETPROD', 'linkedProductId'])
    assert.ok(!t.includes(secret) && !pg.w.document.documentElement.innerHTML.includes(secret), 'must not leak: ' + secret);
  assert.ok(!pg.$('toolsCard').classList.contains('hidden'), 'free tools shown');
});

test('first visit creates a basic profile so the free tools open (and nothing about the seller is touched)', async () => {
  await world();
  const pg = loadPage('billing/supplier/dashboard.html', RAJ);
  await sleep(1500);
  const prof = await read('users/' + RAJ.uid);
  assert.equal(prof.profileComplete, true); assert.equal(prof.businessType, 'Supplier'); assert.equal(prof.email, RAJ.email);
  assert.equal((await read(U)).businessName, 'Seller A Traders');
});

test('an email nobody added gets an empty page, never someone else\'s data', async () => {
  await world();
  const pg = loadPage('billing/supplier/dashboard.html', { uid: C.uid, email: 'stranger@x.in' });
  await sleep(1500);
  assert.match(text(pg), /No buyer has added stranger@x\.in as a supplier/);
  assert.ok(!/Seller A Traders|1,080/.test(text(pg)));
});

test('a supplier cannot read or write the seller\'s records through the database directly', async () => {
  await world();
  const pg = loadPage('billing/supplier/dashboard.html', RAJ);
  await sleep(1200);
  const snap = await pg.w.db.collection('users').doc(A.uid).collection('purchases').get();
  assert.equal(snap.docs.length, 0, 'RLS hides the seller\'s purchases');
  await assert.rejects(pg.w.db.collection('users').doc(A.uid).collection('payments').add({ supplierId: 's1', amount: 99999, date: '2026-10-09' }));
  assert.equal((await list(U + '/payments/')).length, 3, 'no payment was added');
});

test('seller adds a supplier with an email → invite email is sent and a waiting account is let in', async () => {
  await world();
  // the supplier already tried to sign up before being added → PENDING
  await pool.query("insert into auth.users(id,email,raw_user_meta_data) values ('55555555-0000-0000-0000-000000000005','new@supplier.com','{}')");
  assert.equal((await pool.query("select status from public.account_approvals where email='new@supplier.com'")).rows[0].status, 'PENDING');
  const sent = [];
  const pg = loadPage('billing/app.html', A, { before: w => { w.emailjs = { init(){}, send: async (s, t, p) => { sent.push(p); return {}; } }; } });
  await sleep(1800);
  pg.$('sName').value = 'New Supplier Co'; pg.$('sEmail').value = 'New@Supplier.com'; pg.$('sPhone').value = '9876543210';
  await pg.w.eval('saveSupplier()'); await sleep(800);
  assert.equal(sent.length, 1, 'one invite email');
  assert.equal(sent[0].to_email, 'New@Supplier.com');
  assert.match(sent[0].view_link, /\/billing\/supplier\/login\.html\?email=New%40Supplier\.com$/);
  assert.match(sent[0].headline, /Seller A Traders/);
  assert.equal((await pool.query("select status, decided_by from public.account_approvals where email='new@supplier.com'")).rows[0].status, 'APPROVED');
  assert.match(pg.$('supplierMsg').textContent, /Login link emailed to New@Supplier\.com/);
  // saving again with the SAME email does not spam them
  const doc = (await list(U + '/suppliers/')).find(r => r.data.name === 'New Supplier Co');
  await pg.w.eval(`editSupplier('${doc.path.split('/').pop()}')`);
  pg.$('sPhone').value = '9876500000';
  await pg.w.eval('saveSupplier()'); await sleep(600);
  assert.equal(sent.length, 1, 'no second email when the address is unchanged');
  // but the Invite button re-sends on demand
  await pg.w.eval(`inviteSupplierById('${doc.path.split('/').pop()}')`); await sleep(600);
  assert.equal(sent.length, 2);
});

test('a bad email on the supplier card is refused, a supplier without email gets no invite', async () => {
  await world();
  const sent = [];
  const pg = loadPage('billing/app.html', A, { before: w => { w.emailjs = { init(){}, send: async (s, t, p) => { sent.push(p); return {}; } }; } });
  await sleep(1800);
  pg.$('sName').value = 'Bad Email Co'; pg.$('sEmail').value = 'not-an-email';
  await pg.w.eval('saveSupplier()'); await sleep(400);
  assert.match(pg.$('supplierMsg').textContent, /doesn't look right/);
  assert.ok(!(await list(U + '/suppliers/')).some(r => r.data.name === 'Bad Email Co'));
  pg.$('sEmail').value = '';
  await pg.w.eval('saveSupplier()'); await sleep(500);
  assert.equal(sent.length, 0);
  assert.ok((await list(U + '/suppliers/')).some(r => r.data.name === 'Bad Email Co'));
  assert.ok(!/>Invite</.test(pg.$('suppliersTable').innerHTML.split('Bad Email Co')[1].split('</tr>')[0]), 'no Invite button without an email');
});

test('a supplier\'s signup is auto-approved only when a seller listed their email', async () => {
  await world();
  await pool.query("insert into auth.users(id,email,raw_user_meta_data) values ('66666666-0000-0000-0000-000000000006','OTHER@x.com','{}'),('77777777-0000-0000-0000-000000000007','random@nowhere.com','{}')");
  const r = (await pool.query("select email,status,decided_by from public.account_approvals order by email")).rows;
  assert.deepEqual(r.map(x => [x.email.toLowerCase(), x.status]), [['other@x.com', 'APPROVED'], ['random@nowhere.com', 'PENDING']]);
  assert.equal(r[0].decided_by, 'auto:supplier-invite');
});

test('supplier login page asks Supabase for a one-time link to the typed email, and never reveals who is registered', async () => {
  const calls = [];
  const pg = loadPage('billing/supplier/login.html', null, { query: '?email=raj%40fabrics.com', before: w => {
    const orig = w.supabase.createClient;
    w.supabase.createClient = (...a) => { const c = orig(...a); c.auth.signInWithOtp = async x => { calls.push(x); return { error: null }; }; return c; };
  } });
  await sleep(600);
  assert.equal(pg.$('email').value, 'raj@fabrics.com', 'pre-filled from the email link');
  await pg.w.eval('sendLink()'); await sleep(300);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].email, 'raj@fabrics.com');
  assert.equal(calls[0].options.emailRedirectTo, 'https://visutra.in/billing/supplier/dashboard.html');
  assert.ok(!pg.$('sentCard').classList.contains('hidden'));
  assert.match(pg.$('sentCard').textContent, /If raj@fabrics\.com is registered as a supplier/);
});

test('schema.sql and supplier-access.sql carry the SAME signup rule (re-running schema.sql must never switch supplier approval off)', () => {
  const fs = require('fs'), path = require('path');
  const rd = f => fs.readFileSync(path.join(__dirname, '..', 'supabase', f), 'utf8');
  const grab = s => [
    s.match(/create or replace function public\.vt_is_supplier_email[\s\S]*?from public, anon, authenticated;/)[0],
    s.match(/create or replace function public\.vt_new_signup\(\)[\s\S]*?execute function public\.vt_new_signup\(\);/)[0]
  ];
  assert.deepEqual(grab(rd('schema.sql')), grab(rd('supplier-access.sql')));
});
