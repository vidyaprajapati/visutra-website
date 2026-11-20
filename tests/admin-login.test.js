const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { reset, pool, makeClient } = require('./lib/fakesb');
after(async () => { await pool.end(); });
const ADMIN = { uid: '7a0c5b1e-aaaa-4bbb-8ccc-eeeeeeeeeeee', email: 'boss@visutra.in' };
const USER = { uid: '7a0c5b1e-1111-4222-8333-aaaaaaaaaaaa', email: 'u@example.com' };
const as = id => makeClient(() => id);
test('Admin signing up before/after being listed is never stuck PENDING; admin can approve + manage admins', async () => {
  await reset();
  await pool.query('delete from public.account_approvals'); await pool.query('delete from auth.users'); await pool.query('delete from public.store_admins');
  // admin signs up FIRST (not yet listed) → pending, then setup SQL listed them
  await pool.query("insert into auth.users(id,email) values ($1,$2)", [ADMIN.uid, ADMIN.email]);
  assert.equal((await pool.query('select status from public.account_approvals where uid=$1', [ADMIN.uid])).rows[0].status, 'PENDING');
  await pool.query(require('fs').readFileSync(__dirname + '/../supabase/admin-setup.sql', 'utf8').replace('support@visutra.in', ADMIN.email));
  assert.equal((await as(ADMIN).rpc('vt_my_account_status')).data, 'APPROVED');
  await pool.query("insert into auth.users(id,email) values ($1,$2)", [USER.uid, USER.email]);
  assert.equal((await as(ADMIN).rpc('vt_pending_signups')).data, 1);
  assert.equal((await as(ADMIN).rpc('vt_set_account_status', { p_uid: USER.uid, p_status: 'APPROVED' })).error, null);
  assert.equal((await as(USER).rpc('vt_my_account_status')).data, 'APPROVED');
  // non-admin blocked
  assert.match((await as(USER).rpc('vt_admin_add', { p_email: 'x@y.com' })).error.message, /admins only/);
  // add a second admin who signs up afterwards → auto approved
  assert.equal((await as(ADMIN).rpc('vt_admin_add', { p_email: 'Two@Visutra.in' })).error, null);
  await pool.query("insert into auth.users(id,email) values ('7a0c5b1e-2222-4222-8333-bbbbbbbbbbbb','two@visutra.in')");
  assert.equal((await pool.query("select status,decided_by from public.account_approvals where email='two@visutra.in'")).rows[0].status, 'APPROVED');
  assert.deepEqual((await as(ADMIN).rpc('vt_admin_list')).data, [ADMIN.email, 'two@visutra.in']);
  assert.equal((await as(ADMIN).rpc('vt_admin_remove', { p_email: 'two@visutra.in' })).error, null);
  assert.match((await as(ADMIN).rpc('vt_admin_remove', { p_email: ADMIN.email })).error.message, /last admin|LAST_ADMIN/i);
});
