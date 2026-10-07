// Test-only stand-in for supabase-js: runs the adapter's requests as REAL SQL
// against local Postgres, as the signed-in user (role "authenticated" + JWT
// claims), exactly how Supabase's PostgREST does. RLS + triggers apply.
const { Pool } = require('pg');
// Standard PGHOST / PGPORT / PGUSER / PGPASSWORD env vars; database created by setup-db.js
const pool = new Pool({ database: process.env.PGDATABASE_TEST || 'visutra_test', max: 20 });

function colSql(expr) {
  // 'path' | 'data->a->>b' | 'data->a->b'
  const m = expr.split(/(->>|->)/);
  let sql = m[0];
  for (let i = 1; i < m.length; i += 2) sql += m[i] + "'" + m[i + 1].replace(/'/g, "''") + "'";
  const isJson = m.length > 1 && m[m.length - 2] === '->';
  return { sql, isJson };
}
async function asUser(identity, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    if (identity) {
      await c.query('set local role authenticated');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: identity.uid, email: identity.email, role: 'authenticated' })]);
    } else {
      await c.query('set local role anon');
    }
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    try { await c.query('rollback'); } catch (_) {}
    throw e;
  } finally { c.release(); }
}

function makeClient(getIdentity, stats) {
  function builder(table) {
    const st = { where: [], params: [], order: [], range: null, single: false };
    const add = (expr, op, val) => {
      const { sql, isJson } = colSql(expr);
      if (op === 'is') { st.where.push(`${sql} is ${val === null ? 'null' : val}`); return; }
      if (op === 'notnull') { st.where.push(`${sql} is not null`); return; }
      if (op === 'in') { st.params.push(val.map(String)); st.where.push(`${sql} = any($${st.params.length}::text[])`); return; }
      if (op === '@>') { st.params.push(JSON.stringify(val)); st.where.push(`${sql} @> $${st.params.length}::jsonb`); return; }
      if (isJson) { st.params.push(JSON.stringify(val)); st.where.push(`${sql} ${op} $${st.params.length}::jsonb`); }
      else { st.params.push(String(val)); st.where.push(`${sql} ${op} $${st.params.length}`); }
    };
    const b = {
      select() { return b; },
      eq(c, v) { add(c, '=', v); return b; }, neq(c, v) { add(c, '<>', v); return b; },
      lt(c, v) { add(c, '<', v); return b; }, lte(c, v) { add(c, '<=', v); return b; },
      gt(c, v) { add(c, '>', v); return b; }, gte(c, v) { add(c, '>=', v); return b; },
      in(c, v) { add(c, 'in', v); return b; }, is(c, v) { add(c, 'is', v); return b; },
      contains(c, v) { add(c, '@>', v); return b; },
      not(c, op, v) { if (op === 'is' && v === null) add(c, 'notnull'); else throw new Error('not() op'); return b; },
      order(c, o) { const { sql } = colSql(c); st.order.push(`${sql} ${o && o.ascending === false ? 'desc' : 'asc'} ${o && o.nullsFirst ? 'nulls first' : 'nulls last'}`); return b; },
      range(a, z) { st.range = [a, z]; return b; },
      maybeSingle() { st.single = true; return b; },
      then(res, rej) {
        const sql = `select path, data, version from ${table}` + (st.where.length ? ' where ' + st.where.join(' and ') : '') +
          (st.order.length ? ' order by ' + st.order.join(', ') : '') +
          (st.range ? ` limit ${st.range[1] - st.range[0] + 1} offset ${st.range[0]}` : '');
        if (stats) stats.reads++;
        return asUser(getIdentity(), c => c.query(sql, st.params)).then(r => {
          if (st.single) { if (r.rows.length > 1) return { data: null, error: { message: 'multiple rows' } }; return { data: r.rows[0] || null, error: null }; }
          return { data: r.rows, error: null };
        }, e => ({ data: null, error: { message: e.message } })).then(res, rej);
      }
    };
    return b;
  }
  return {
    from: t => builder('public.' + t),
    rpc(name, args) {
      if (stats) stats.rpcs++;
      let sql, params;
      if (name === 'vt_commit') { sql = 'select public.vt_commit($1::jsonb, $2::jsonb) as r'; params = [JSON.stringify(args.ops), JSON.stringify(args.pre || [])]; }
      else if (name === 'vt_get_public') { sql = 'select public.vt_get_public($1) as r'; params = [args.p_path]; }
      else if (name === 'vt_export_mine') { sql = 'select coalesce(json_agg(d), \'[]\') as r from public.vt_export_mine() d'; params = []; }
      else if (/^[a-z_][a-z0-9_]*$/.test(name)) {   // any other database function, like Supabase's /rpc/<name>
        const keys = Object.keys(args || {});
        sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
        params = keys.map(k => (args[k] !== null && typeof args[k] === 'object') ? JSON.stringify(args[k]) : args[k]);
      }
      else return Promise.resolve({ data: null, error: { message: 'unknown rpc ' + name } });
      return asUser(getIdentity(), c => c.query(sql, params)).then(r => ({ data: r.rows[0].r, error: null }), e => ({ data: null, error: { message: e.message } }));
    },
    auth: {
      getSession: async () => { const id = getIdentity(); return { data: { session: id ? { user: userObj(id), access_token: 't' } : null } }; },
      getUser: async () => { const id = getIdentity(); return { data: { user: id ? userObj(id) : null } }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({}),
    }
  };
}
function userObj(id) { return { id: id.uid, email: id.email, email_confirmed_at: '2026-01-01T00:00:00Z', user_metadata: id.meta || {}, identities: [{}] }; }

// Service-role helpers for seeding / checking (bypass RLS — like the SQL editor)
async function seed(path, data) { await pool.query('insert into public.docs(path,data) values($1,$2) on conflict(path) do update set data=excluded.data', [path, data]); }
async function read(path) { const r = await pool.query('select data from public.docs where path=$1', [path]); return r.rows[0] ? r.rows[0].data : undefined; }
async function list(prefix) { const r = await pool.query("select path,data from public.docs where path like $1 order by path", [prefix + '%']); return r.rows; }
async function reset() { await pool.query('truncate public.docs'); }
module.exports = { makeClient, seed, read, list, reset, pool };
