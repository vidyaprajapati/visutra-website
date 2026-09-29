// Creates a fresh Supabase-like test database and loads ../supabase/schema.sql.
// Uses the standard PGHOST / PGPORT / PGUSER / PGPASSWORD environment variables.
const fs = require('fs'), path = require('path');
const { Client } = require('pg');
const DB = process.env.PGDATABASE_TEST || 'visutra_test';
(async () => {
  const admin = new Client({ database: 'postgres' });
  await admin.connect();
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()`, [DB]);
  await admin.query(`drop database if exists ${DB}`);
  await admin.query(`create database ${DB}`);
  await admin.query(`do $$ begin
      if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$`);
  await admin.end();
  const c = new Client({ database: DB });
  await c.connect();
  // The pieces of Supabase the schema relies on: roles + auth.uid() / auth.jwt()
  await c.query(`
    create schema if not exists auth;
    create or replace function auth.jwt() returns jsonb language sql stable as $$
      select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(auth.jwt()->>'sub','')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;`);
  await c.query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
  // running it twice must be safe (the setup guide says so)
  await c.query(fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8'));
  await c.end();
  console.log(`Test database "${DB}" ready (schema.sql loaded twice without errors).`);
})().catch(e => { console.error('setup-db failed:', e.message); process.exit(1); });
