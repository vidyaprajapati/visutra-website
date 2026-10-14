const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, sleep, closeAll, A } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });
const N = { uid: '7a0c5b1e-1111-4222-8333-944455556666', email: 'newseller@example.com' };   // a brand-new sign-up
const ADMIN = { uid: '7a0c5b1e-aaaa-4bbb-8ccc-dddddddddddd', email: 'support@visutra.in' };
const as = id => makeClient(() => id);
async function world() {
  await reset();
  await pool.query('delete from public.account_approvals'); await pool.query('delete from auth.users');
  await pool.query("insert into public.store_admins(email) values ('support@visutra.in') on conflict do nothing");
  await seed('users/' + A.uid, { businessName: 'Visu trader', profileComplete: true });
  // Supabase creating the account (sign-up form details in the metadata)
  await pool.query('insert into auth.users(id, email, raw_user_meta_data) values ($1, $2, $3)', [N.uid, N.email,
    JSON.stringify({ vt_signup: { fullName: 'New Seller', businessType: 'Retailer', mobileNumber: '9876543210', username: 'newseller' }, full_name: 'New Seller' })]);
}
const write = (id, path, data) => as(id).rpc('vt_commit', { ops: [{ op: 'set', path, data }], pre: [] });

test('New sign-ups are PENDING and locked out of all data until an admin approves', async () => {
  await world();
  const row = (await pool.query('select * from public.account_approvals where uid = $1', [N.uid])).rows[0];
  assert.deepEqual([row.status, row.name, row.business_type, row.mobile, row.username, row.email], ['PENDING', 'New Seller', 'Retailer', '9876543210', 'newseller', N.email]);
  assert.equal((await as(N).rpc('vt_my_account_status')).data, 'PENDING');
  // pending: no writes, no reads, no directory look-ups
  assert.ok((await write(N, `users/${N.uid}`, { businessName: 'X' })).error, 'pending account cannot write');
  await pool.query("insert into public.docs(path, data) values ($1, '{\"a\":1}'::jsonb) on conflict do nothing", [`users/${N.uid}/products/p1`]).catch(() => {});
  const c = await pool.connect();   // read as that signed-in person (row-level security applies)
  try {
    await c.query('begin'); await c.query('set local role authenticated');
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: N.uid, email: N.email, role: 'authenticated' })]);
    const r = await c.query('select count(*)::int as n from public.docs where path like $1', [`users/${N.uid}%`]);
    assert.equal(r.rows[0].n, 0, 'pending account reads nothing — not even its own data');
    await c.query('rollback');
  } finally { c.release(); }
  assert.match((await as(N).rpc('vt_get_public', { p_path: 'buyerDirectory/x' })).error.message, /waiting for approval/);
  // existing accounts are not affected
  assert.equal((await as(A).rpc('vt_my_account_status')).data, 'APPROVED');
  assert.equal((await write(A, `users/${A.uid}/products/p9`, { name: 'Cover' })).error, null);
  // only admins can list / decide (not the person themself)
  assert.match((await as(N).rpc('vt_account_approvals')).error.message, /admins only/);
  assert.match((await as(N).rpc('vt_set_account_status', { p_uid: N.uid, p_status: 'APPROVED' })).error.message, /admins only/);
  assert.match((await as(A).rpc('vt_set_account_status', { p_uid: N.uid, p_status: 'APPROVED' })).error.message, /admins only/);
  assert.equal((await as(A).rpc('vt_pending_signups')).data, 0);
  // admin
  assert.equal((await as(ADMIN).rpc('vt_pending_signups')).data, 1);
  const list = (await as(ADMIN).rpc('vt_account_approvals')).data;
  assert.equal(list[0].uid, N.uid);
  const ok = await as(ADMIN).rpc('vt_set_account_status', { p_uid: N.uid, p_status: 'APPROVED' });
  assert.deepEqual([ok.data.status, ok.data.decided_by], ['APPROVED', 'support@visutra.in']);
  assert.equal((await write(N, `users/${N.uid}`, { businessName: 'New Seller Co' })).error, null, 'approved → can save');
  assert.equal((await read(`users/${N.uid}`)).businessName, 'New Seller Co');
  // reject → locked again
  await as(ADMIN).rpc('vt_set_account_status', { p_uid: N.uid, p_status: 'REJECTED' });
  assert.ok((await write(N, `users/${N.uid}`, { businessName: 'Y' })).error, 'rejected → locked');
  assert.equal((await as(N).rpc('vt_my_account_status')).data, 'REJECTED');
});

test('Pages: pending accounts are signed out, the admin gets the sign-up email, approving emails the user', async () => {
  await world();
  // a page opened with a pending account's session → signed out
  let pg = loadPage('billing/buyer/stock.html', N); await sleep(900);
  assert.equal(pg.w.firebase.auth().currentUser, null, 'pending session is dropped');
  // signing in with a pending account → clear message
  await assert.rejects(pg.w.firebase.auth().signInWithEmailAndPassword(N.email, 'secret1'), e => e.code === 'auth/account-pending' && /waiting for approval/.test(e.message));
  closeAll();
  // sign-up page: notification to VISUTRA with an Approve link
  const sent = [];
  pg = loadPage('billing/login.html', null, { before: w => { w.emailjs = { init() {}, send: async (s, t, p) => { sent.push(p); } }; } }); await sleep(500);
  pg.w.notifyAdminOfSignup({ uid: N.uid, name: 'New Seller', email: N.email, businessType: 'Retailer', mobile: '9876543210', username: 'newseller' }); await sleep(50);
  assert.equal(sent[0].to_email, 'support@visutra.in');
  assert.match(sent[0].email_subject, /New sign-up waiting for approval: New Seller/);
  assert.match(sent[0].detail_line, /New Seller · newseller@example\.com · Retailer · Mobile 9876543210 · @newseller/);
  assert.match(sent[0].view_link, new RegExp('/billing/admin-approvals\\.html\\?uid=' + N.uid));
  closeAll();
  // admin page: approve → status saved + "approved" email to the user
  const mails = [];
  pg = loadPage('billing/admin-approvals.html', ADMIN, { query: '?uid=' + N.uid, before: w => { w.emailjs = { init() {}, send: async (s, t, p) => { mails.push(p); } }; } }); await sleep(900);
  assert.match(pg.$('apList').textContent, /New Seller\s*Waiting/); assert.match(pg.$('apTabs').textContent, /Waiting \(1\)/);
  await pg.w.decide(N.uid, 'APPROVED'); await sleep(100);
  assert.equal((await pool.query('select status from public.account_approvals where uid = $1', [N.uid])).rows[0].status, 'APPROVED');
  assert.deepEqual([mails[0].to_email, mails[0].email_subject], [N.email, 'Your VISUTRA account is approved']);
  closeAll();
  // a non-admin sees "admins only"
  pg = loadPage('billing/admin-approvals.html', A); await sleep(900);
  assert.match(pg.$('apList').textContent, /Only VISUTRA admins/);
});
