-- =====================================================================
-- VISUTRA on Supabase — run this ONCE in Supabase → SQL Editor → New query
-- (safe to re-run: everything is "create or replace" / "if not exists").
--
-- Design: every record the website stores lives in ONE table, `docs`,
-- addressed by the same paths the site already uses
-- (e.g. users/<uid>/products/<id>, sellerLinks/<id>). The website talks to
-- it through billing/assets/vt-firebase-compat.js, so the pages themselves
-- did not need rewriting.
--
-- Security: Row Level Security below is a line-by-line port of the old
-- firestore.rules — each user reaches only their own data, plus exactly the
-- shared buyer/seller records they're a party to.
-- =====================================================================

create table if not exists public.docs (
  path        text primary key,
  col         text generated always as (regexp_replace(path, '/[^/]+$', '')) stored,
  id          text generated always as (regexp_replace(path, '^.*/', '')) stored,
  owner       text generated always as (
                case when path like 'users/%' then split_part(path, '/', 2) end
              ) stored,
  top         text generated always as (split_part(path, '/', 1)) stored,
  data        jsonb not null default '{}'::jsonb,
  version     bigint not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists docs_col_idx   on public.docs (col);
create index if not exists docs_owner_idx on public.docs (owner);
create index if not exists docs_data_gin  on public.docs using gin (data jsonb_path_ops);

alter table public.docs enable row level security;

-- ---------------------------------------------------------------------
-- Helpers (SECURITY DEFINER so policies can look up other rows without
-- recursing into RLS).
-- ---------------------------------------------------------------------
create or replace function public.vt_uid() returns text
language sql stable as $$ select auth.uid()::text $$;

create or replace function public.vt_link_active(p_seller text, p_buyer text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.docs
    where path = 'sellerLinks/' || p_seller || '_' || p_buyer
      and data->>'status' = 'ACTIVE'
  )
$$;

-- ---------------------------------------------------------------------
-- READ rules
-- ---------------------------------------------------------------------
drop policy if exists docs_select on public.docs;
create policy docs_select on public.docs for select to authenticated using (
  -- your own profile and everything under users/<you>/…
  owner = public.vt_uid()
  -- a linked buyer may read a seller's ACTIVE, buyer-visible products
  or (col = 'users/' || owner || '/products'
      and data->>'active' = 'true' and data->>'buyerVisibility' = 'true'
      and public.vt_link_active(owner, public.vt_uid()))
  -- shared buyer/seller records: only the two parties
  or (top in ('sellerLinks','marketplaceOrders','invoiceDeleteRequests','paymentConfirmations')
      and public.vt_uid() in (data->>'sellerUid', data->>'buyerUid'))
  -- legacy supplier orders
  or (top = 'orders' and (data->>'buyerUid' = public.vt_uid()
                          or data->>'supplierEmail' = (auth.jwt()->>'email')))
  -- your OWN entries in the look-up-only collections (needed to update them;
  -- nobody can list anyone else's)
  or (top in ('usernames','buyerDirectory') and data->>'uid' = public.vt_uid())
  or (top = 'public_invoices' and data->>'sellerUid' = public.vt_uid())
);
-- NOTE: usernames, buyerDirectory and public_invoices are NOT listable at
-- all (the old rules allowed only single-document reads). They're read one
-- document at a time through vt_get_public() below.

-- ---------------------------------------------------------------------
-- WRITE rules: own data by path; shared collections are allowed through
-- to the guard trigger, which enforces the exact old rules (it can see
-- both the old and the new record, which a policy can't).
-- ---------------------------------------------------------------------
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated with check (
  owner = public.vt_uid()
  or top in ('sellerLinks','buyerDirectory','marketplaceOrders','invoiceDeleteRequests',
             'paymentConfirmations','public_invoices','orders','usernames')
);
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (
    owner = public.vt_uid()
    or top in ('sellerLinks','buyerDirectory','marketplaceOrders','invoiceDeleteRequests',
               'paymentConfirmations','public_invoices','orders','usernames')
  )
  with check (
    owner = public.vt_uid()
    or top in ('sellerLinks','buyerDirectory','marketplaceOrders','invoiceDeleteRequests',
               'paymentConfirmations','public_invoices','orders','usernames')
  );
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated using (
  owner = public.vt_uid() or top in ('buyerDirectory','orders')
);

-- ---------------------------------------------------------------------
-- Guard trigger — the old firestore.rules for shared collections.
-- ---------------------------------------------------------------------
create or replace function public.vt_changed_keys(o jsonb, n jsonb) returns text[]
language sql immutable as $$
  select coalesce(array_agg(k), '{}') from (
    select k from jsonb_object_keys(coalesce(o,'{}') || coalesce(n,'{}')) k
    where (o->k) is distinct from (n->k)
  ) s
$$;

create or replace function public.vt_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  me text := public.vt_uid();
  o jsonb := case when tg_op in ('UPDATE','DELETE') then old.data end;
  n jsonb := case when tg_op in ('INSERT','UPDATE') then new.data end;
  -- (generated columns like "top" aren't filled in yet inside a BEFORE
  -- trigger, so read the collection straight from the path)
  t text  := split_part(case when tg_op = 'DELETE' then old.path else new.path end, '/', 1);
  ch text[];
begin
  -- Service role / SQL editor (no signed-in user): unrestricted.
  if me is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- A document can't be moved between owners / paths.
  if tg_op = 'UPDATE' and new.path <> old.path then raise exception 'VT_DENIED: path change'; end if;

  if t = 'sellerLinks' then
    if tg_op = 'INSERT' then
      if n->>'sellerUid' is distinct from me then raise exception 'VT_DENIED: sellerLinks create'; end if;
    elsif tg_op = 'UPDATE' then
      ch := public.vt_changed_keys(o, n);
      if not (o->>'sellerUid' = me
              or (o->>'buyerUid' = me and ch <@ array['status','removedAt'] and n->>'status' = 'REMOVED_BY_BUYER')) then
        raise exception 'VT_DENIED: sellerLinks update';
      end if;
    else raise exception 'VT_DENIED: sellerLinks delete'; end if;

  elsif t = 'buyerDirectory' then
    if tg_op in ('INSERT','UPDATE') and n->>'uid' is distinct from me then raise exception 'VT_DENIED: buyerDirectory'; end if;
    if tg_op = 'UPDATE' and o->>'uid' is distinct from me then raise exception 'VT_DENIED: buyerDirectory'; end if;
    if tg_op = 'DELETE' and o->>'uid' is distinct from me then raise exception 'VT_DENIED: buyerDirectory delete'; end if;

  elsif t = 'marketplaceOrders' then
    if tg_op = 'INSERT' then
      if not (
        (n->>'buyerUid' = me and n->>'status' = 'PENDING' and public.vt_link_active(n->>'sellerUid', me))
        or (n->>'sellerUid' = me and n->>'status' = 'PENDING_BUYER_CONFIRMATION' and public.vt_link_active(me, n->>'buyerUid'))
      ) then raise exception 'VT_DENIED: marketplaceOrders create'; end if;
    elsif tg_op = 'UPDATE' then
      ch := public.vt_changed_keys(o, n);
      if not (
        (o->>'sellerUid' = me and o->>'status' = 'PENDING' and n->>'status' in ('ACCEPTED','REJECTED'))
        or (o->>'buyerUid' = me and o->>'status' = 'ACCEPTED' and not (o ? 'buyerPurchaseId')
            and ch <@ array['buyerPurchaseId','buyerPurchaseCreatedAt'])
        or (o->>'buyerUid' = me and o->>'status' = 'PENDING_BUYER_CONFIRMATION' and n->>'status' in ('ACCEPTED','REJECTED')
            and ch <@ array['status','acceptedAt','respondedAt','rejectionReason'])
        or (o->>'sellerUid' = me and o->>'status' = 'REJECTED' and ch <@ array['stockReversed']
            and n->>'stockReversed' = 'true')
      ) then raise exception 'VT_DENIED: marketplaceOrders update'; end if;
    else raise exception 'VT_DENIED: marketplaceOrders delete'; end if;

  elsif t = 'invoiceDeleteRequests' then
    if tg_op = 'INSERT' then
      if not (n->>'sellerUid' = me and n->>'status' = 'PENDING') then raise exception 'VT_DENIED: invoiceDeleteRequests create'; end if;
    elsif tg_op = 'UPDATE' then
      ch := public.vt_changed_keys(o, n);
      if not (
        (o->>'sellerUid' = me and o->>'status' = 'ACCEPTED' and n->>'status' = 'COMPLETED' and ch <@ array['status','completedAt'])
        or (o->>'buyerUid' = me and o->>'status' = 'PENDING' and n->>'status' in ('ACCEPTED','REJECTED') and ch <@ array['status','respondedAt'])
      ) then raise exception 'VT_DENIED: invoiceDeleteRequests update'; end if;
    else raise exception 'VT_DENIED: invoiceDeleteRequests delete'; end if;

  elsif t = 'paymentConfirmations' then
    if tg_op = 'INSERT' then
      if not (n->>'buyerUid' = me and n->>'status' = 'PENDING' and public.vt_link_active(n->>'sellerUid', me)) then
        raise exception 'VT_DENIED: paymentConfirmations create'; end if;
    elsif tg_op = 'UPDATE' then
      ch := public.vt_changed_keys(o, n);
      if not (o->>'sellerUid' = me and o->>'status' = 'PENDING' and n->>'status' in ('APPROVED','REJECTED')
              and ch <@ array['status','respondedAt']) then
        raise exception 'VT_DENIED: paymentConfirmations update'; end if;
    else raise exception 'VT_DENIED: paymentConfirmations delete'; end if;

  elsif t = 'public_invoices' then
    if tg_op = 'INSERT' and n->>'sellerUid' is distinct from me then raise exception 'VT_DENIED: public_invoices create'; end if;
    if tg_op = 'UPDATE' and (o->>'sellerUid' is distinct from me or n->>'sellerUid' is distinct from o->>'sellerUid') then
      raise exception 'VT_DENIED: public_invoices update'; end if;
    if tg_op = 'DELETE' then raise exception 'VT_DENIED: public_invoices delete'; end if;

  elsif t = 'usernames' then
    if tg_op = 'INSERT' and n->>'uid' is distinct from me then raise exception 'VT_DENIED: usernames create'; end if;
    if tg_op in ('UPDATE','DELETE') then raise exception 'VT_DENIED: usernames are permanent'; end if;

  elsif t = 'orders' then
    if tg_op = 'INSERT' and n->>'buyerUid' is distinct from me then raise exception 'VT_DENIED: orders create'; end if;
    if tg_op = 'UPDATE' and not (o->>'buyerUid' = me or o->>'supplierEmail' = (auth.jwt()->>'email')) then
      raise exception 'VT_DENIED: orders update'; end if;
    if tg_op = 'DELETE' and o->>'buyerUid' is distinct from me then raise exception 'VT_DENIED: orders delete'; end if;

  elsif t = 'users' then
    -- own data only (the RLS policy already checked owner = me)
    null;
  else
    raise exception 'VT_DENIED: unknown collection %', t;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update or delete on public.docs
  for each row execute function public.vt_guard();

-- ---------------------------------------------------------------------
-- Field transforms used by the website:
--   {"__vt":"inc","n":5}  → add 5 to the current number (missing = 0)
--   {"__vt":"ts"}         → server time, stored as {"__ts":"2026-…Z"}
--   {"__vt":"del"}        → remove the field
-- ---------------------------------------------------------------------
create or replace function public.vt_now_ts() returns jsonb
language sql stable as $$
  select jsonb_build_object('__ts', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$$;

-- Resolve transforms in `n` against the old value `o`. When deep is true,
-- nested objects merge with the old ones (Firestore set(..., {merge:true})).
create or replace function public.vt_resolve(o jsonb, n jsonb, deep boolean) returns jsonb
language plpgsql stable as $$
declare
  res jsonb;
  k text; v jsonb; ov jsonb;
begin
  if jsonb_typeof(n) is distinct from 'object' then return n; end if;
  if n ? '__vt' then
    if n->>'__vt' = 'inc' then
      return to_jsonb(coalesce(case when jsonb_typeof(o) = 'number' then (o#>>'{}')::numeric end, 0) + (n->>'n')::numeric);
    elsif n->>'__vt' = 'ts' then
      return public.vt_now_ts();
    end if;
    return n;
  end if;
  res := case when deep and jsonb_typeof(o) = 'object' then o else '{}'::jsonb end;
  for k, v in select * from jsonb_each(n) loop
    ov := case when jsonb_typeof(o) = 'object' then o->k end;
    if jsonb_typeof(v) = 'object' and v->>'__vt' = 'del' then
      res := res - k;
    elsif jsonb_typeof(v) = 'object' and not (v ? '__vt') and not (v ? '__ts') then
      res := jsonb_set(res, array[k], public.vt_resolve(ov, v, deep));
    else
      res := jsonb_set(res, array[k], public.vt_resolve(ov, v, deep));
    end if;
  end loop;
  return res;
end $$;

-- update() with dotted field paths ("pending.abc": …) — each key replaces
-- that one field (creating parent maps as needed).
create or replace function public.vt_update_fields(o jsonb, n jsonb) returns jsonb
language plpgsql stable as $$
declare
  res jsonb := coalesce(o, '{}'::jsonb);
  k text; v jsonb; p text[]; i int;
begin
  for k, v in select * from jsonb_each(n) loop
    p := string_to_array(k, '.');
    if jsonb_typeof(v) = 'object' and v->>'__vt' = 'del' then
      res := res #- p;
    else
      -- make sure every parent map exists
      for i in 1 .. array_length(p, 1) - 1 loop
        if jsonb_typeof(res #> p[1:i]) is distinct from 'object' then
          res := jsonb_set(res, p[1:i], '{}'::jsonb, true);
        end if;
      end loop;
      res := jsonb_set(res, p, public.vt_resolve(res #> p, v, false), true);
    end if;
  end loop;
  return res;
end $$;

-- ---------------------------------------------------------------------
-- vt_commit — ALL writes go through here, atomically (all or nothing).
--   pre: [{ "path": "...", "version": 3 | null }]   (transactions: must be
--        unchanged since read; null = must not exist) → else VT_CONFLICT,
--        and the website retries the whole transaction.
--   ops: [{ "op": "set"|"update"|"delete", "path": "...", "data": {...},
--           "merge": true|false }]
-- Runs as the signed-in user, so RLS + the guard trigger apply.
-- ---------------------------------------------------------------------
create or replace function public.vt_commit(ops jsonb, pre jsonb default '[]'::jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  c jsonb; op jsonb; cur record; nd jsonb; p text; out jsonb := '[]'::jsonb;
  found_row boolean; n_rows int;
begin
  for c in select * from jsonb_array_elements(coalesce(pre, '[]'::jsonb)) loop
    select version into cur from public.docs where path = c->>'path' for update;
    if (c->'version' = 'null'::jsonb and found)
       or (c->'version' <> 'null'::jsonb and (not found or cur.version <> (c->>'version')::bigint)) then
      raise exception 'VT_CONFLICT: %', c->>'path';
    end if;
  end loop;

  for op in select * from jsonb_array_elements(ops) loop
    p := op->>'path';
    -- a document path is collection/doc(/collection/doc)*  (even number of parts)
    if p is null or p !~ '^[^/]+/[^/]+(/[^/]+/[^/]+)*$' then
      raise exception 'VT_BAD_PATH: %', p;
    end if;
    select data, version into cur from public.docs where path = p for update;
    found_row := found;

    if op->>'op' = 'delete' then
      delete from public.docs where path = p;
      -- RLS silently skips rows you may not delete — report it instead.
      get diagnostics n_rows = row_count;
      if found_row and n_rows = 0 then raise exception 'VT_DENIED: delete %', p; end if;
    elsif op->>'op' = 'update' then
      if not found_row then raise exception 'VT_NOT_FOUND: %', p; end if;
      nd := public.vt_update_fields(cur.data, op->'data');
      update public.docs set data = nd, version = version + 1, updated_at = now() where path = p;
    else -- set
      nd := public.vt_resolve(case when found_row then cur.data end, op->'data', coalesce((op->>'merge')::boolean, false));
      insert into public.docs (path, data) values (p, nd)
        on conflict (path) do update set data = excluded.data, version = public.docs.version + 1, updated_at = now();
    end if;
    out := out || jsonb_build_object('path', p);
  end loop;
  return out;
end $$;

-- ---------------------------------------------------------------------
-- Single-document reads for the three "look up one, never list" collections
-- (old rules: get allowed, list denied).
--   usernames/<name>       — anyone (login by username happens before sign-in)
--   public_invoices/<id>   — anyone with the invoice link
--   buyerDirectory/<email> — signed-in users (seller linking a buyer)
-- ---------------------------------------------------------------------
create or replace function public.vt_get_public(p_path text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r record;
begin
  if p_path !~ '^(usernames|public_invoices|buyerDirectory)/[^/]+$' then
    raise exception 'VT_DENIED: not a public document';
  end if;
  if p_path like 'buyerDirectory/%' and auth.uid() is null then
    raise exception 'VT_DENIED: sign in first';
  end if;
  select path, data, version into r from public.docs where path = p_path;
  if not found then return null; end if;
  return jsonb_build_object('path', r.path, 'data', r.data, 'version', r.version);
end $$;

-- ---------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------
-- Postgres lets EVERYONE (role "public") run a new function by default —
-- take that away first, then grant exactly what's needed.
revoke all on public.docs from anon, public;
grant select, insert, update, delete on public.docs to authenticated;
revoke execute on function public.vt_commit(jsonb, jsonb) from public, anon;
grant execute on function public.vt_commit(jsonb, jsonb) to authenticated;
revoke execute on function public.vt_get_public(text) from public;
grant execute on function public.vt_get_public(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- "Export all my data" (backup) — returns every record the caller can see
-- under their own account.
-- ---------------------------------------------------------------------
create or replace function public.vt_export_mine() returns setof public.docs
language sql stable security invoker as $$
  select * from public.docs where owner = public.vt_uid() order by path
$$;
revoke execute on function public.vt_export_mine() from public, anon;
grant execute on function public.vt_export_mine() to authenticated;

-- =====================================================================
-- Shop (visutra.in product catalogue + admin.html) — replaces the old
-- Google Apps Script + Google Sheet.
-- =====================================================================
create table if not exists public.store_products (
  id          text primary key default replace(gen_random_uuid()::text, '-', ''),
  name        text not null,
  category    text default '',
  tag         text default '',
  price       text default '',
  description text default '',
  "imageUrl"  text default '',
  featured    boolean not null default false,
  active      boolean not null default true,
  sort        int not null default 0,
  updated_at  timestamptz not null default now()
);
-- Who may edit the shop: add your login email(s) here, e.g.
--   insert into public.store_admins(email) values ('support@visutra.in');
create table if not exists public.store_admins (email text primary key);

alter table public.store_products enable row level security;
alter table public.store_admins enable row level security;

create or replace function public.vt_is_store_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.store_admins where lower(email) = lower(auth.jwt()->>'email'))
$$;

drop policy if exists store_products_public on public.store_products;
create policy store_products_public on public.store_products for select to anon, authenticated
  using (active or public.vt_is_store_admin());
drop policy if exists store_products_admin on public.store_products;
create policy store_products_admin on public.store_products for all to authenticated
  using (public.vt_is_store_admin()) with check (public.vt_is_store_admin());
drop policy if exists store_admins_self on public.store_admins;
create policy store_admins_self on public.store_admins for select to authenticated
  using (lower(email) = lower(auth.jwt()->>'email'));

grant select on public.store_products to anon;
grant select, insert, update, delete on public.store_products to authenticated;
grant select on public.store_admins to authenticated;
revoke execute on function public.vt_is_store_admin() from public;
grant execute on function public.vt_is_store_admin() to anon, authenticated;
