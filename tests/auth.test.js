const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed, read, list, reset, pool, makeClient } = require('./lib/fakesb');
const { loadPage, loadCore, mkPdf, sleep, closeAll, A, B, C } = require('./lib/sbload');
after(async () => { closeAll(); await pool.end(); });

const fs = require('fs'); const { JSDOM } = require('jsdom'); const { R } = require('./lib/sbload');
test('coming back to the tab does not restart the page (Supabase SIGNED_IN on focus)', async () => {
  const u1 = { id: 'u1', email: 'a@x.in', email_confirmed_at: '2026-01-01' }, u2 = { id: 'u2', email: 'b@x.in', email_confirmed_at: '2026-01-01' };
  const auth = { session: { user: u1 }, cbs: [], getSession: async () => ({ data: { session: auth.session } }), onAuthStateChange: cb => { auth.cbs.push(cb); return { data: { subscription: { unsubscribe(){} } } }; },
    fire(ev, user){ auth.session = user ? { user } : null; auth.cbs.forEach(cb => cb(ev, auth.session)); }, signOut: async () => { auth.fire('SIGNED_OUT', null); return {}; } };
  const w = new JSDOM('', { runScripts: 'outside-only', url: 'https://visutra.in/billing/app.html' }).window;
  w.supabase = { createClient: () => ({ auth, from(){}, rpc(){} }) };
  w.eval(fs.readFileSync(R + 'billing/assets/vt-firebase-compat.js', 'utf8') + fs.readFileSync(R + 'billing/assets/firebase-config.js', 'utf8') + ';window.auth=auth;');
  const calls = []; w.auth.onAuthStateChanged(u => calls.push(u ? u.email : 'out'));
  await sleep(20);
  auth.fire('SIGNED_IN', u1); auth.fire('TOKEN_REFRESHED', u1); auth.fire('SIGNED_IN', u1); await sleep(10);
  assert.deepEqual(calls, ['a@x.in'], 'page init ran once');
  auth.fire('SIGNED_OUT', null); await sleep(10); auth.fire('SIGNED_IN', u2); await sleep(10);
  assert.deepEqual(calls, ['a@x.in', 'out', 'b@x.in'], 'real sign-out / sign-in still reported');
  w.close();
});

test('first sign-in after email confirmation creates the profile and claims the username', async () => {
  await reset();
  await seed('usernames/taken_name', { uid: 'dddddddd-0000-0000-0000-000000000004', email: 'd@x.in' });
  const NEW = { uid: 'eeeeeeee-0000-0000-0000-000000000005', email: 'ravi@shop.in', meta: { vt_signup: { fullName: 'Ravi Kumar', businessType: 'Retailer', mobileNumber: '9876543210', username: 'ravi_shop' } } };
  loadPage('billing/login.html', NEW); await sleep(900);
  const prof = await read('users/' + NEW.uid);
  assert.deepEqual([prof.fullName, prof.username, prof.profileComplete], ['Ravi Kumar', 'ravi_shop', true]);
  assert.equal((await read('usernames/ravi_shop')).uid, NEW.uid);
  const TAKEN = { uid: 'ffffffff-0000-0000-0000-000000000006', email: 'x@shop.in', meta: { vt_signup: { fullName: 'X', businessType: 'Retailer', mobileNumber: '1', username: 'taken_name' } } };
  loadPage('billing/login.html', TAKEN); await sleep(900);
  const p2 = await read('users/' + TAKEN.uid);
  assert.deepEqual([p2.username, p2.profileComplete], ['', false], 'taken username → asked to complete the profile');
  assert.equal((await read('usernames/taken_name')).uid.slice(0, 8), 'dddddddd', 'other owner untouched');
});
