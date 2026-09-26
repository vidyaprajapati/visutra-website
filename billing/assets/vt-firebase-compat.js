/* VISUTRA — Firebase-compatible layer on Supabase.
   ------------------------------------------------------------------------
   The website was written against the Firebase "compat" API (auth(),
   firestore(), collection().doc().get(), transactions, batches…). This file
   provides that same API but stores everything in Supabase (Postgres), so
   the 31 pages work unchanged. No Google service is used.

   Storage model: one table `docs` (see supabase/schema.sql) keyed by the
   same paths the site already uses, e.g. users/<uid>/products/<id>.
   All writes go through the vt_commit() database function — atomic, with
   Row Level Security + a guard trigger enforcing the old Firestore rules.

   Needs (loaded before this file): supabase-js v2 (window.supabase).
   Configured by firebase-config.js via firebase.initializeApp({ supabaseUrl,
   supabaseKey }).
   ------------------------------------------------------------------------ */
(function (global) {
  'use strict';

  let sbClient = null;
  let appConfig = null;
  function sb() {
    if (!sbClient) {
      if (!appConfig) throw new Error('VISUTRA: firebase.initializeApp() was not called');
      sbClient = global.supabase.createClient(appConfig.supabaseUrl, appConfig.supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
    }
    return sbClient;
  }

  /* ---------------- errors (Firebase-style code + message) ---------------- */
  function fsError(err) {
    const msg = (err && (err.message || err.details || err.hint)) || String(err);
    let code = 'unknown';
    if (/VT_CONFLICT/.test(msg)) code = 'aborted';
    else if (/VT_NOT_FOUND/.test(msg)) code = 'not-found';
    else if (/VT_DENIED|row-level security|permission denied|42501/.test(msg)) code = 'permission-denied';
    else if (/Failed to fetch|NetworkError|network/i.test(msg)) code = 'unavailable';
    const friendly = code === 'permission-denied' ? 'Missing or insufficient permissions.'
      : code === 'not-found' ? 'No document to update: ' + msg.replace(/^.*VT_NOT_FOUND:\s*/, '')
      : code === 'unavailable' ? 'Could not reach the server — check your internet connection.'
      : msg;
    const e = new Error(friendly);
    e.code = code;
    e.raw = msg;
    return e;
  }

  /* ---------------- values ---------------- */
  class Timestamp {
    constructor(ms) { this._ms = ms; }
    static now() { return new Timestamp(Date.now()); }
    static fromDate(d) { return new Timestamp(d.getTime()); }
    static fromMillis(ms) { return new Timestamp(ms); }
    toDate() { return new Date(this._ms); }
    toMillis() { return this._ms; }
    get seconds() { return Math.floor(this._ms / 1000); }
    get nanoseconds() { return (this._ms % 1000) * 1e6; }
    isEqual(o) { return o instanceof Timestamp && o._ms === this._ms; }
    valueOf() { return this._ms; }
    toJSON() { return new Date(this._ms).toISOString(); }
    toString() { return 'Timestamp(' + new Date(this._ms).toISOString() + ')'; }
  }
  class FieldValue {
    constructor(kind, n) { this._kind = kind; this._n = n; }
    static increment(n) { return new FieldValue('inc', Number(n) || 0); }
    static serverTimestamp() { return new FieldValue('ts'); }
    static delete() { return new FieldValue('del'); }
    static arrayUnion() { throw new Error('arrayUnion is not supported'); }
    static arrayRemove() { throw new Error('arrayRemove is not supported'); }
  }
  function ser(v) {
    if (v === undefined) return undefined;
    if (v === null || typeof v !== 'object') return (typeof v === 'number' && !isFinite(v)) ? null : v;
    if (v instanceof FieldValue) return v._kind === 'inc' ? { __vt: 'inc', n: v._n } : { __vt: v._kind };
    if (v instanceof Timestamp) return { __ts: new Date(v._ms).toISOString() };
    if (v instanceof Date) return { __ts: v.toISOString() };
    if (Array.isArray(v)) return v.map(x => { const s = ser(x); return s === undefined ? null : s; });
    const out = {};
    Object.keys(v).forEach(k => { const s = ser(v[k]); if (s !== undefined) out[k] = s; });
    return out;
  }
  function deser(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(deser);
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '__ts' && typeof v.__ts === 'string') return new Timestamp(Date.parse(v.__ts));
    const out = {};
    keys.forEach(k => { out[k] = deser(v[k]); });
    return out;
  }

  /* ---------------- snapshots ---------------- */
  class DocumentSnapshot {
    constructor(ref, row) {
      this.ref = ref; this.id = ref.id;
      this.exists = !!row;
      this._data = row ? row.data : undefined;
      this._version = row ? row.version : null;
    }
    data() { return this.exists ? deser(this._data) : undefined; }
    get(field) {
      if (!this.exists) return undefined;
      return deser(String(field).split('.').reduce((o, k) => (o == null ? undefined : o[k]), this._data));
    }
  }
  class QuerySnapshot {
    constructor(docs) { this.docs = docs; this.size = docs.length; this.empty = docs.length === 0; }
    forEach(cb) { this.docs.forEach(cb); }
    docChanges() { return this.docs.map((doc, i) => ({ type: 'added', doc, oldIndex: -1, newIndex: i })); }
  }

  /* ---------------- reads ---------------- */
  // Look-up-only collections: one document at a time via vt_get_public().
  const PUBLIC_GET = /^(usernames|public_invoices|buyerDirectory)\/[^/]+$/;
  async function readRow(path) {
    if (PUBLIC_GET.test(path)) {
      const { data, error } = await sb().rpc('vt_get_public', { p_path: path });
      if (error) throw fsError(error);
      return data || null;
    }
    const { data, error } = await sb().from('docs').select('path,data,version').eq('path', path).maybeSingle();
    if (error) throw fsError(error);
    return data || null;
  }
  function jsonPath(field, asText) {
    const parts = String(field).split('.');
    const last = parts.pop();
    return 'data' + parts.map(p => '->' + p).join('') + (asText ? '->>' : '->') + last;
  }
  function applyFilter(qb, f) {
    const { field, op, value } = f;
    const isNum = typeof value === 'number', isBool = typeof value === 'boolean';
    const col = (isNum || isBool) ? jsonPath(field, false) : jsonPath(field, true);
    switch (op) {
      case '==': return value === null ? qb.is(jsonPath(field, false), null) : qb.eq(col, value);
      case '!=': return qb.neq(col, value);
      case '<': return qb.lt(col, value);
      case '<=': return qb.lte(col, value);
      case '>': return qb.gt(col, value);
      case '>=': return qb.gte(col, value);
      case 'in': return qb.in(jsonPath(field, true), (value || []).map(String));
      case 'array-contains': return qb.contains(jsonPath(field, false), [value]);
      default: throw new Error('Unsupported query operator: ' + op);
    }
  }
  const PAGE = 1000;
  async function runQuery(q) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      let qb = sb().from('docs').select('path,data,version').eq('col', q._path);
      q._filters.forEach(f => { qb = applyFilter(qb, f); });
      q._orders.forEach(o => {
        // Firestore leaves out documents that don't have the orderBy field.
        qb = qb.not(jsonPath(o.field, false), 'is', null)
               .order(jsonPath(o.field, false), { ascending: o.dir !== 'desc', nullsFirst: false });
      });
      qb = qb.order('path', { ascending: true });
      const want = q._limit != null ? Math.min(PAGE, q._limit - rows.length) : PAGE;
      if (want <= 0) break;
      qb = qb.range(from, from + want - 1);
      const { data, error } = await qb;
      if (error) throw fsError(error);
      rows.push(...(data || []));
      if (!data || data.length < want || (q._limit != null && rows.length >= q._limit)) break;
    }
    return new QuerySnapshot(rows.map(r => new DocumentSnapshot(new DocumentReference(r.path), r)));
  }
  // Live listeners: re-read every few seconds while the page is open (and
  // on tab focus). Plenty for order lists; no realtime setup needed.
  function poll(fetcher, onNext, onError, ms) {
    let stopped = false, timer = null, last = null;
    async function tick() {
      if (stopped) return;
      try {
        const snap = await fetcher();
        const sig = JSON.stringify(snap.docs ? snap.docs.map(d => [d.id, d._version]) : [snap.exists, snap._version]);
        if (sig !== last) { last = sig; onNext && onNext(snap); }
      } catch (e) { onError && onError(e); }
      if (!stopped) timer = setTimeout(tick, ms || 8000);
    }
    const onFocus = () => { if (!stopped) { clearTimeout(timer); tick(); } };
    global.addEventListener && global.addEventListener('focus', onFocus);
    tick();
    return () => { stopped = true; clearTimeout(timer); global.removeEventListener && global.removeEventListener('focus', onFocus); };
  }

  /* ---------------- writes ---------------- */
  async function commit(ops, pre) {
    if (!ops.length) return;
    const { error } = await sb().rpc('vt_commit', { ops, pre: pre || [] });
    if (error) throw fsError(error);
  }
  function setOp(ref, data, opts) {
    if (!data || typeof data !== 'object') throw new Error('set() needs an object');
    return { op: 'set', path: ref.path, data: ser(data), merge: !!(opts && opts.merge) };
  }
  function updateOp(ref, data) {
    if (!data || typeof data !== 'object') throw new Error('update() needs an object');
    return { op: 'update', path: ref.path, data: ser(data) };
  }

  /* ---------------- references & queries ---------------- */
  const AUTO_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  function autoId() {
    let s = '';
    const buf = (global.crypto && global.crypto.getRandomValues) ? global.crypto.getRandomValues(new Uint8Array(20)) : null;
    for (let i = 0; i < 20; i++) s += AUTO_CHARS[(buf ? buf[i] : Math.floor(Math.random() * 256)) % AUTO_CHARS.length];
    return s;
  }
  class Query {
    constructor(path, filters, orders, limit) {
      this._path = path; this._filters = filters || []; this._orders = orders || []; this._limit = limit == null ? null : limit;
    }
    where(field, op, value) { return new Query(this._path, this._filters.concat([{ field, op, value }]), this._orders, this._limit); }
    orderBy(field, dir) { return new Query(this._path, this._filters, this._orders.concat([{ field, dir: dir || 'asc' }]), this._limit); }
    limit(n) { return new Query(this._path, this._filters, this._orders, n); }
    get() { return runQuery(this); }
    onSnapshot(onNext, onError) {
      if (typeof onNext === 'object' && onNext) { onError = onNext.error; onNext = onNext.next; }
      return poll(() => runQuery(this), onNext, onError);
    }
  }
  class CollectionReference extends Query {
    constructor(path) { super(path); this.path = path; this.id = path.split('/').pop(); }
    doc(id) { return new DocumentReference(this.path + '/' + (id == null ? autoId() : id)); }
    async add(data) { const ref = this.doc(); await ref.set(data); return ref; }
    get parent() { const p = this.path.split('/'); return p.length > 1 ? new DocumentReference(p.slice(0, -1).join('/')) : null; }
  }
  class DocumentReference {
    constructor(path) { this.path = path; this.id = path.split('/').pop(); }
    get parent() { return new CollectionReference(this.path.split('/').slice(0, -1).join('/')); }
    collection(name) { return new CollectionReference(this.path + '/' + name); }
    async get() { return new DocumentSnapshot(this, await readRow(this.path)); }
    set(data, opts) { return commit([setOp(this, data, opts)]); }
    update(data) { return commit([updateOp(this, data)]); }
    delete() { return commit([{ op: 'delete', path: this.path }]); }
    onSnapshot(onNext, onError) {
      if (typeof onNext === 'object' && onNext) { onError = onNext.error; onNext = onNext.next; }
      return poll(() => this.get(), onNext, onError);
    }
    isEqual(o) { return o instanceof DocumentReference && o.path === this.path; }
  }
  class WriteBatch {
    constructor() { this._ops = []; }
    set(ref, data, opts) { this._ops.push(setOp(ref, data, opts)); return this; }
    update(ref, data) { this._ops.push(updateOp(ref, data)); return this; }
    delete(ref) { this._ops.push({ op: 'delete', path: ref.path }); return this; }
    commit() { return commit(this._ops); }
  }
  class Transaction {
    constructor() { this._ops = []; this._pre = new Map(); }
    async get(ref) {
      const row = await readRow(ref.path);
      if (!this._pre.has(ref.path)) this._pre.set(ref.path, row ? row.version : null);
      return new DocumentSnapshot(ref, row);
    }
    set(ref, data, opts) { this._ops.push(setOp(ref, data, opts)); return this; }
    update(ref, data) { this._ops.push(updateOp(ref, data)); return this; }
    delete(ref) { this._ops.push({ op: 'delete', path: ref.path }); return this; }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  class Firestore {
    collection(path) { return new CollectionReference(path); }
    doc(path) { return new DocumentReference(path); }
    batch() { return new WriteBatch(); }
    // Optimistic transaction: reads are remembered with their version; the
    // commit fails with VT_CONFLICT if any changed meanwhile, and the whole
    // function is re-run (like Firestore). Up to 8 attempts.
    async runTransaction(fn) {
      let lastErr;
      for (let attempt = 0; attempt < 8; attempt++) {
        const tx = new Transaction();
        const result = await fn(tx);
        const pre = [...tx._pre.entries()].map(([path, version]) => ({ path, version }));
        try {
          if (tx._ops.length) await commit(tx._ops, pre);
          return result;
        } catch (e) {
          lastErr = e;
          if (e.code !== 'aborted') throw e;
          await sleep(30 + Math.random() * 120 * (attempt + 1));
        }
      }
      throw lastErr;
    }
    // Bulk read (not in the Firebase web API): many documents in a few
    // requests instead of one request each. Used by reconciliation matching.
    async getAll(refs) {
      const out = new Map();
      const paths = refs.map(r => r.path).filter(p => !PUBLIC_GET.test(p));
      for (let i = 0; i < paths.length; i += 150) {
        const chunk = paths.slice(i, i + 150);
        const { data, error } = await sb().from('docs').select('path,data,version').in('path', chunk);
        if (error) throw fsError(error);
        (data || []).forEach(r => out.set(r.path, r));
      }
      return refs.map(r => new DocumentSnapshot(r, out.get(r.path) || null));
    }
    enablePersistence() { return Promise.resolve(); }
    settings() {}
  }
  Firestore.FieldValue = FieldValue;
  Firestore.Timestamp = Timestamp;

  /* ---------------- auth ---------------- */
  function authError(err) {
    const msg = (err && err.message) || String(err);
    let code = 'auth/error', text = msg;
    if (/invalid login credentials/i.test(msg)) { code = 'auth/invalid-credential'; text = 'Wrong email or password.'; }
    else if (/email not confirmed/i.test(msg)) { code = 'auth/email-not-verified'; text = 'Please confirm your email first — check your inbox for the link.'; }
    else if (/already registered|already been registered|user_already_exists/i.test(msg)) { code = 'auth/email-already-in-use'; text = 'An account with this email already exists — sign in instead.'; }
    else if (/password should be|weak password|password is too/i.test(msg)) { code = 'auth/weak-password'; text = msg; }
    else if (/invalid format|valid email|email address .* is invalid/i.test(msg)) { code = 'auth/invalid-email'; text = 'That email address doesn\u2019t look right.'; }
    else if ((err && err.status === 429) || /rate limit|for security purposes|too many/i.test(msg)) { code = 'auth/too-many-requests'; text = 'Too many attempts — please wait a minute and try again.'; }
    else if (/failed to fetch|network/i.test(msg)) { code = 'auth/network-request-failed'; text = 'Could not reach the server — check your internet connection.'; }
    const e = new Error(text); e.code = code; e.raw = msg; return e;
  }
  const origin = () => (global.location ? global.location.origin : '');
  const LOGIN_PATH = '/billing/login.html';
  const RESET_PATH = '/billing/reset-password.html';

  class User {
    constructor(u, auth) { this._auth = auth; this._apply(u); }
    _apply(u) {
      this.uid = u.id;
      this.email = u.email || null;
      this.emailVerified = !!(u.email_confirmed_at || u.confirmed_at);
      const md = u.user_metadata || {};
      this.displayName = md.full_name || md.name || md.displayName || null;
      this.photoURL = md.avatar_url || null;
      this.phoneNumber = u.phone || null;
      this.providerData = [{ providerId: 'password', uid: u.email, email: u.email }];
      this.metadata = { creationTime: u.created_at, lastSignInTime: u.last_sign_in_at };
      // Details typed on the sign-up form (name, username…) — kept with the
      // account until the profile is created at the first confirmed sign-in.
      this.signupData = md.vt_signup || null;
    }
    async reload() {
      const { data, error } = await sb().auth.getUser();
      if (error) throw authError(error);
      if (data && data.user) this._apply(data.user);
    }
    async getIdToken() { const { data } = await sb().auth.getSession(); return data.session ? data.session.access_token : null; }
    async sendEmailVerification() {
      if (this._justSignedUp) return; // Supabase already emailed the confirmation link at sign-up
      const { error } = await sb().auth.resend({ type: 'signup', email: this.email, options: { emailRedirectTo: origin() + LOGIN_PATH } });
      if (error) throw authError(error);
    }
    async updatePassword(pw) { const { error } = await sb().auth.updateUser({ password: pw }); if (error) throw authError(error); }
    async updateProfile(p) {
      const md = {};
      if (p && 'displayName' in p) md.full_name = p.displayName;
      const { data, error } = await sb().auth.updateUser({ data: md });
      if (error) throw authError(error);
      if (data && data.user) this._apply(data.user);
    }
    async reauthenticateWithCredential(cred) {
      const { error } = await sb().auth.signInWithPassword({ email: cred.email, password: cred.password });
      if (error) throw authError(error);
      return { user: this };
    }
    reauthenticateWithPopup() { return Promise.reject(authError(new Error('Google sign-in is no longer available — use your email and password.'))); }
    // Change login email: Supabase emails a confirmation link; the change
    // takes effect when it's clicked (same behaviour as Firebase).
    async verifyBeforeUpdateEmail(newEmail) {
      const { error } = await sb().auth.updateUser({ email: newEmail }, { emailRedirectTo: origin() + LOGIN_PATH });
      if (error) throw authError(error);
    }
    async updateEmail(newEmail) { return this.verifyBeforeUpdateEmail(newEmail); }
    async linkWithCredential(cred) { await this.updatePassword(cred.password); return { user: this }; }
  }

  class Auth {
    constructor() {
      this.currentUser = null;
      this._listeners = [];
      this._ready = false;
      const client = sb();
      client.auth.getSession().then(({ data }) => {
        this._set(data && data.session ? data.session.user : null);
        this._ready = true;
        this._emit();
      }).catch(() => { this._ready = true; this._emit(); });
      client.auth.onAuthStateChange((event, session) => {
        if (event === 'INITIAL_SESSION') return; // handled by getSession above
        const before = this.currentUser ? this.currentUser.uid : null;
        this._set(session ? session.user : null);
        const after = this.currentUser ? this.currentUser.uid : null;
        if (this._ready && (before !== after || event === 'USER_UPDATED' || event === 'SIGNED_IN')) this._emit();
      });
    }
    _set(u) {
      if (!u) { this.currentUser = null; return; }
      if (this.currentUser && this.currentUser.uid === u.id) this.currentUser._apply(u);
      else this.currentUser = new User(u, this);
    }
    _emit() { this._listeners.slice().forEach(cb => { try { cb(this.currentUser); } catch (e) { console.error(e); } }); }
    onAuthStateChanged(cb) {
      this._listeners.push(cb);
      if (this._ready) setTimeout(() => cb(this.currentUser), 0);
      return () => { this._listeners = this._listeners.filter(x => x !== cb); };
    }
    async signInWithEmailAndPassword(email, password) {
      const { data, error } = await sb().auth.signInWithPassword({ email, password });
      if (error) throw authError(error);
      this._set(data.user);
      return { user: this.currentUser };
    }
    // signupData (optional, not in Firebase): stored with the account and used
    // to create the profile after the email is confirmed.
    async createUserWithEmailAndPassword(email, password, signupData) {
      const options = { emailRedirectTo: origin() + LOGIN_PATH };
      if (signupData) options.data = { vt_signup: signupData, full_name: signupData.fullName || undefined };
      const { data, error } = await sb().auth.signUp({ email, password, options });
      if (error) throw authError(error);
      // Supabase hides "already registered" (returns a user with no identities)
      if (data && data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        throw authError(new Error('User already registered'));
      }
      const user = new User(data.user, this);
      user._justSignedUp = true;
      if (data.session) this._set(data.user);
      return { user };
    }
    async sendPasswordResetEmail(email) {
      const { error } = await sb().auth.resetPasswordForEmail(email, { redirectTo: origin() + RESET_PATH });
      if (error) throw authError(error);
    }
    async signOut() {
      await sb().auth.signOut();
      if (this.currentUser) { this._set(null); this._emit(); } // (Supabase's own SIGNED_OUT event may have done it already)
    }
    // Resend the sign-up confirmation link — no password needed (not in Firebase).
    async resendVerificationEmail(email) {
      const { error } = await sb().auth.resend({ type: 'signup', email, options: { emailRedirectTo: origin() + LOGIN_PATH } });
      if (error) throw authError(error);
    }
    signInWithPopup() { return Promise.reject(authError(new Error('Google sign-in is no longer available — use your email and password.'))); }
    signInWithRedirect() { return this.signInWithPopup(); }
    setPersistence() { return Promise.resolve(); }
    useDeviceLanguage() {}
  }

  /* ---------------- the global "firebase" object ---------------- */
  let authSingleton = null, dbSingleton = null;
  function authFn() { if (!authSingleton) authSingleton = new Auth(); return authSingleton; }
  authFn.GoogleAuthProvider = function GoogleAuthProvider() {};
  authFn.EmailAuthProvider = { credential: (email, password) => ({ email, password }) };
  authFn.Auth = { Persistence: { LOCAL: 'local', SESSION: 'session', NONE: 'none' } };
  function firestoreFn() { if (!dbSingleton) dbSingleton = new Firestore(); return dbSingleton; }
  firestoreFn.FieldValue = FieldValue;
  firestoreFn.Timestamp = Timestamp;

  global.firebase = {
    initializeApp(cfg) { appConfig = cfg; return { name: '[DEFAULT]' }; },
    auth: authFn,
    firestore: firestoreFn,
    apps: [],
    // Direct Supabase access for pages that need it (e.g. data export).
    supabase: () => sb()
  };
})(typeof window !== 'undefined' ? window : globalThis);
