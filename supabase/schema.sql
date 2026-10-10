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
  or (top in ('sellerLinks','marketplaceOrders','invoiceDeleteRequests','paymentConfirmations','paymentDeleteRequests')
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
             'paymentConfirmations','paymentDeleteRequests','public_invoices','orders','usernames')
);
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (
    owner = public.vt_uid()
    or top in ('sellerLinks','buyerDirectory','marketplaceOrders','invoiceDeleteRequests',
               'paymentConfirmations','paymentDeleteRequests','public_invoices','orders','usernames')
  )
  with check (
    owner = public.vt_uid()
    or top in ('sellerLinks','buyerDirectory','marketplaceOrders','invoiceDeleteRequests',
               'paymentConfirmations','paymentDeleteRequests','public_invoices','orders','usernames')
  );
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated using (
  owner = public.vt_uid() or top in ('buyerDirectory','orders')
);

-- ---------------------------------------------------------------------
-- Guard trigger — the old firestore.rules for shared collections.
-- ---------------------------------------------------------------------
-- GST month lock: users/<uid>/gstPeriods/<YYYY-MM> with status GENERATED or
-- FILED. Once a month's GSTR has been generated, no invoice/purchase dated in
-- it may be deleted or restored — by anyone, from any page or device.
create or replace function public.vt_period_lock(p_uid text, p_date text) returns text
language sql stable security definer set search_path = public as $$
  select case when coalesce(p_uid, '') = '' or coalesce(p_date, '') = '' then null else (
    select data->>'status' from public.docs
    where path = 'users/' || p_uid || '/gstPeriods/' || substr(p_date, 1, 7)
      and data->>'status' in ('GENERATED', 'FILED')) end
$$;
create or replace function public.vt_month_label(p_date text) returns text
language sql immutable as $$
  select to_char(to_date(substr(p_date, 1, 7) || '-01', 'YYYY-MM-DD'), 'FMMonth YYYY')
$$;

create or replace function public.vt_changed_keys(o jsonb, n jsonb) returns text[]
language sql immutable as $$
  select coalesce(array_agg(k), '{}') from (
    select k from jsonb_object_keys(coalesce(o,'{}') || coalesce(n,'{}')) k
    where (o->k) is distinct from (n->k)
  ) s
$$;

-- Refuse an invoice deletion request (and its approval) when the invoice's
-- month is locked on the SELLER's side, or the purchase's month on the BUYER's.
create or replace function public.vt_assert_unlocked_for_request(n jsonb) returns void
language plpgsql stable security definer set search_path = public as $$
declare seller text := n->>'sellerUid'; buyer text := n->>'buyerUid'; d text; lk text; pur jsonb; ord jsonb;
begin
  if coalesce(n->>'invoiceId', '') <> '' then
    select data->>'date' into d from docs where path = 'users/' || seller || '/invoices/' || (n->>'invoiceId');
  elsif coalesce(n->>'orderId', '') <> '' then
    select data->>'date' into d from docs where col = 'users/' || seller || '/invoices' and data->>'sourceOrderId' = (n->>'orderId') limit 1;
  end if;
  d := coalesce(d, nullif(n->>'invoiceDate', ''));
  lk := public.vt_period_lock(seller, d);
  if lk is not null then
    raise exception 'VT_LOCKED: the seller has already % GSTR for % — invoice % can''t be deleted on either side (issue a credit note instead).',
      case when lk = 'FILED' then 'filed' else 'generated' end, public.vt_month_label(d), coalesce(n->>'invoiceNo', '');
  end if;
  -- every buyer purchase belonging to this invoice (by id, by order, by invoice)
  if coalesce(n->>'orderId', '') <> '' then select data into ord from docs where path = 'marketplaceOrders/' || (n->>'orderId'); end if;
  select data into pur from docs
   where col = 'users/' || buyer || '/buyerPurchases'
     and (path = 'users/' || buyer || '/buyerPurchases/' || coalesce(nullif(n->>'purchaseId', ''), '-')
          or path = 'users/' || buyer || '/buyerPurchases/' || coalesce(nullif(ord->>'buyerPurchaseId', ''), '-')
          or (coalesce(n->>'invoiceId', '') <> '' and (data->>'sellerInvoiceId' = (n->>'invoiceId') or data->>'invoiceId' = (n->>'invoiceId'))))
     and (data->>'gstFiled' = 'true' or public.vt_period_lock(buyer, data->>'date') is not null)
   limit 1;
  if pur is not null then
    raise exception 'VT_LOCKED: the buyer has already filed GST for % — this purchase can''t be deleted on either side.', public.vt_month_label(pur->>'date');
  end if;
end $$;

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
  -- NOTE: every rule below is "if not coalesce((allowed), false) then refuse":
  -- a rule that comes out unknown (e.g. comparing a field the record doesn't
  -- have) must count as NOT allowed — plain "if not (unknown)" would let it through.
  if me is null or coalesce(current_setting('vt.system', true), '') = 'on' then
    -- no signed-in user (SQL editor), or the database's own approval
    -- finalizer (vt_finalize_request) completing both sides of a request
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  -- A document can't be moved between owners / paths.
  if tg_op = 'UPDATE' and new.path <> old.path then raise exception 'VT_DENIED: path change'; end if;

  if t = 'sellerLinks' then
    if tg_op = 'INSERT' then
      if n->>'sellerUid' is distinct from me then raise exception 'VT_DENIED: sellerLinks create'; end if;
    elsif tg_op = 'UPDATE' then
      ch := public.vt_changed_keys(o, n);
      if not coalesce((o->>'sellerUid' = me
              or (o->>'buyerUid' = me and ch <@ array['status','removedAt'] and n->>'status' = 'REMOVED_BY_BUYER')), false) then
        raise exception 'VT_DENIED: sellerLinks update';
      end if;
    else raise exception 'VT_DENIED: sellerLinks delete'; end if;

  elsif t = 'buyerDirectory' then
    if tg_op in ('INSERT','UPDATE') and n->>'uid' is distinct from me then raise exception 'VT_DENIED: buyerDirectory'; end if;
    if tg_op = 'UPDATE' and o->>'uid' is distinct from me then raise exception 'VT_DENIED: buyerDirectory'; end if;
    if tg_op = 'DELETE' and o->>'uid' is distinct from me then raise exception 'VT_DENIED: buyerDirectory delete'; end if;

  elsif t = 'marketplaceOrders' then
    if tg_op = 'INSERT' then
      if not coalesce((
        (n->>'buyerUid' = me and n->>'status' = 'PENDING' and public.vt_link_active(n->>'sellerUid', me))
        or (n->>'sellerUid' = me and n->>'status' = 'PENDING_BUYER_CONFIRMATION' and public.vt_link_active(me, n->>'buyerUid'))
        -- partly accepted order: the items the seller did NOT tick move to a
        -- new pending order — only as the remainder of an order between the
        -- same seller and buyer
        or (n->>'sellerUid' = me and n->>'status' = 'PENDING' and coalesce(n->>'splitFromOrderId', '') <> ''
            and public.vt_link_active(me, n->>'buyerUid')
            and exists (select 1 from public.docs d where d.path = 'marketplaceOrders/' || (n->>'splitFromOrderId')
                        and d.data->>'sellerUid' = me and d.data->>'buyerUid' = n->>'buyerUid'))
      ), false) then raise exception 'VT_DENIED: marketplaceOrders create'; end if;
    elsif tg_op = 'UPDATE' then
      ch := public.vt_changed_keys(o, n);
      if not coalesce((
        (o->>'sellerUid' = me and o->>'status' = 'PENDING' and n->>'status' in ('ACCEPTED','REJECTED'))
        or (o->>'buyerUid' = me and o->>'status' = 'ACCEPTED' and not (o ? 'buyerPurchaseId')
            and ch <@ array['buyerPurchaseId','buyerPurchaseCreatedAt'])
        or (o->>'buyerUid' = me and o->>'status' = 'PENDING_BUYER_CONFIRMATION' and n->>'status' in ('ACCEPTED','REJECTED')
            and ch <@ array['status','acceptedAt','respondedAt','rejectionReason'])
        or (o->>'sellerUid' = me and o->>'status' = 'REJECTED' and ch <@ array['stockReversed']
            and n->>'stockReversed' = 'true')
      ), false) then raise exception 'VT_DENIED: marketplaceOrders update'; end if;
    else raise exception 'VT_DENIED: marketplaceOrders delete'; end if;

  elsif t = 'invoiceDeleteRequests' then
    -- Either side may ask (requestedBy 'seller' — the default — or 'buyer');
    -- the OTHER side approves or rejects; the asker may cancel.
    if tg_op = 'INSERT' then
      if not coalesce((n->>'status' = 'PENDING' and coalesce(n->>'sellerUid','') <> '' and coalesce(n->>'buyerUid','') <> '' and (
        (coalesce(n->>'requestedBy', 'seller') = 'seller' and n->>'sellerUid' = me)
        or (n->>'requestedBy' = 'buyer' and n->>'buyerUid' = me))), false) then
        raise exception 'VT_DENIED: invoiceDeleteRequests create'; end if;
      perform public.vt_assert_unlocked_for_request(n);
    elsif tg_op = 'UPDATE' then
      ch := public.vt_changed_keys(o, n);
      if not coalesce((
        (o->>'status' = 'PENDING' and ch <@ array['status','respondedAt','buyerNote'] and n->>'status' in ('ACCEPTED','REJECTED') and (
          (coalesce(o->>'requestedBy', 'seller') = 'seller' and o->>'buyerUid' = me) or (o->>'requestedBy' = 'buyer' and o->>'sellerUid' = me)))
        or (o->>'status' = 'PENDING' and ch <@ array['status','respondedAt'] and n->>'status' = 'CANCELLED' and (
          (coalesce(o->>'requestedBy', 'seller') = 'seller' and o->>'sellerUid' = me) or (o->>'requestedBy' = 'buyer' and o->>'buyerUid' = me)))
        -- legacy: a seller finishing an old request approved before automatic completion
        or (o->>'sellerUid' = me and o->>'status' = 'ACCEPTED' and n->>'status' = 'COMPLETED' and ch <@ array['status','completedAt'])
      ), false) then raise exception 'VT_DENIED: invoiceDeleteRequests update'; end if;
    else raise exception 'VT_DENIED: invoiceDeleteRequests delete'; end if;

  elsif t = 'paymentConfirmations' then
    if tg_op = 'INSERT' then
      if not coalesce((n->>'buyerUid' = me and n->>'status' = 'PENDING' and public.vt_link_active(n->>'sellerUid', me)), false) then
        raise exception 'VT_DENIED: paymentConfirmations create'; end if;
    elsif tg_op = 'UPDATE' then
      ch := public.vt_changed_keys(o, n);
      if not coalesce((
        (o->>'sellerUid' = me and o->>'status' = 'PENDING' and n->>'status' in ('APPROVED','REJECTED')
          and ch <@ array['status','respondedAt','customerId','customerName'])
        or (o->>'buyerUid' = me and o->>'status' = 'PENDING' and n->>'status' = 'CANCELLED'
          and ch <@ array['status','respondedAt'])
      ), false) then raise exception 'VT_DENIED: paymentConfirmations update'; end if;
    else raise exception 'VT_DENIED: paymentConfirmations delete'; end if;

  elsif t = 'paymentDeleteRequests' then
    -- Either side asks; the OTHER side approves or rejects; the asker may cancel.
    if tg_op = 'INSERT' then
      if not coalesce((n->>'status' = 'PENDING' and coalesce(n->>'sellerUid','') <> '' and coalesce(n->>'buyerUid','') <> ''
              and ((n->>'requestedBy' = 'buyer' and n->>'buyerUid' = me) or (n->>'requestedBy' = 'seller' and n->>'sellerUid' = me))), false) then
        raise exception 'VT_DENIED: paymentDeleteRequests create'; end if;
    elsif tg_op = 'UPDATE' then
      ch := public.vt_changed_keys(o, n);
      if not coalesce((o->>'status' = 'PENDING' and ch <@ array['status','respondedAt'] and (
        (n->>'status' in ('ACCEPTED','REJECTED') and ((o->>'requestedBy' = 'buyer' and o->>'sellerUid' = me) or (o->>'requestedBy' = 'seller' and o->>'buyerUid' = me)))
        or (n->>'status' = 'CANCELLED' and ((o->>'requestedBy' = 'buyer' and o->>'buyerUid' = me) or (o->>'requestedBy' = 'seller' and o->>'sellerUid' = me)))
      )), false) then raise exception 'VT_DENIED: paymentDeleteRequests update'; end if;
    else raise exception 'VT_DENIED: paymentDeleteRequests delete'; end if;

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
    -- own data only (the RLS policy already checked owner = me), plus the GST month lock:
    declare
      sub text := split_part(coalesce(new.path, old.path), '/', 3);
      owner_uid text := split_part(coalesce(new.path, old.path), '/', 2);
      lk text;
    begin
      if sub = 'gstPeriods' and tg_op in ('UPDATE', 'DELETE') and o->>'status' = 'FILED' then
        raise exception 'VT_LOCKED: % is marked as filed — it can''t be re-opened.', public.vt_month_label(split_part(old.path, '/', 4));
      end if;
      if sub in ('invoices', 'purchases') and tg_op = 'UPDATE'
         and coalesce(o->>'deleted', 'false') is distinct from coalesce(n->>'deleted', 'false') then
        lk := public.vt_period_lock(owner_uid, o->>'date');
        if lk is not null or o->>'gstFiled' = 'true' then
          raise exception 'VT_LOCKED: GSTR for % is already % — this % can''t be % (issue a credit note instead).',
            public.vt_month_label(o->>'date'), lower(coalesce(lk, 'filed')), case when sub = 'invoices' then 'invoice' else 'purchase' end,
            case when n->>'deleted' = 'true' then 'deleted' else 'restored' end;
        end if;
      end if;
      if sub in ('invoices', 'purchases', 'buyerPurchases') and tg_op = 'DELETE' then
        lk := public.vt_period_lock(owner_uid, o->>'date');
        if (lk is not null or o->>'gstFiled' = 'true') and coalesce(o->>'deleted', 'false') <> 'true' then
          raise exception 'VT_LOCKED: GSTR for % is already % — this record can''t be deleted.', public.vt_month_label(o->>'date'), lower(coalesce(lk, 'filed'));
        end if;
      end if;
    end;
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
  found_row boolean; n_rows int; must_not_exist jsonb := '{}'::jsonb;
begin
  for c in select * from jsonb_array_elements(coalesce(pre, '[]'::jsonb)) loop
    if c->'version' = 'null'::jsonb then must_not_exist := must_not_exist || jsonb_build_object(c->>'path', true); end if;
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
      if must_not_exist ? p and found_row then
        -- Read as "not there" at the start, but another device created it
        -- while this commit was waiting for its turn → re-run the transaction.
        raise exception 'VT_CONFLICT: %', p;
      elsif must_not_exist ? p then
        -- A transaction read this document as "not there yet" (e.g. a "label
        -- already printed" marker). Row locks can't cover a row that doesn't
        -- exist, so insert WITHOUT upsert: if another device created it a
        -- moment ago, this fails and the website re-runs the transaction —
        -- which then sees it and doesn't deduct stock a second time.
        begin
          insert into public.docs (path, data) values (p, nd);
        exception when unique_violation then
          raise exception 'VT_CONFLICT: %', p;
        end;
      else
        insert into public.docs (path, data) values (p, nd)
          on conflict (path) do update set data = excluded.data, version = public.docs.version + 1, updated_at = now();
      end if;
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
-- Approval finalizer — when the other party APPROVES a request, both sides
-- are completed right there, in the same transaction as the approval:
--   invoiceDeleteRequests  PENDING → ACCEPTED  : seller invoice → Recycle Bin
--       + seller stock back; buyer's purchase removed + buyer stock back
--   paymentConfirmations   PENDING → APPROVED  : seller Receipt created, buyer
--       payment CONFIRMED;  → REJECTED/CANCELLED : buyer's pending payment removed
--   paymentDeleteRequests  PENDING → ACCEPTED  : seller receipt AND buyer
--       payment both → deleted
-- Anything that fails (e.g. already filed in GST) cancels the approval too.
-- ---------------------------------------------------------------------
create or replace function public.vt_today() returns text language sql stable as $$
  select to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD') $$;
create or replace function public.vt_new_doc(p_col text, p_data jsonb) returns text
language plpgsql as $$
declare p text := p_col || '/' || replace(gen_random_uuid()::text, '-', '');
begin insert into public.docs (path, data) values (p, p_data); return split_part(p, '/', array_length(string_to_array(p, '/'), 1)); end $$;
create or replace function public.vt_patch(p_path text, p_patch jsonb) returns void
language sql as $$
  update public.docs set data = data || p_patch, version = version + 1, updated_at = now() where path = p_path $$;
create or replace function public.vt_bump(p_path text, p_delta numeric) returns void
language sql as $$
  update public.docs set data = jsonb_set(data, '{stock}', to_jsonb(coalesce((data->>'stock')::numeric, 0) + p_delta)),
    version = version + 1, updated_at = now() where path = p_path $$;

-- A notification in someone's own account (shown in the 🔔 bar until dismissed).
create or replace function public.vt_notify(p_uid text, p_kind text, p_text text) returns void
language plpgsql as $$
begin
  if coalesce(p_uid, '') = '' then return; end if;
  perform vt_new_doc('users/' || p_uid || '/notifications', jsonb_build_object('kind', p_kind, 'text', p_text, 'read', false, 'createdAt', vt_now_ts()));
end $$;

create or replace function public.vt_finalize_request() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n jsonb := new.data; o jsonb := old.data; t text := split_part(new.path, '/', 1);
  req_id text := split_part(new.path, '/', 2);
  seller text; buyer text; inv jsonb; inv_path text; pur jsonb; pur_path text; ord jsonb; it jsonb; q numeric; rid text;
  seller_name text; buyer_name text; asker text; approver_name text; what text;
begin
  if coalesce(o->>'status','') <> 'PENDING' or coalesce(n->>'status','') = 'PENDING' then return new; end if;
  seller := n->>'sellerUid'; buyer := n->>'buyerUid';
  perform set_config('vt.system', 'on', true);
  seller_name := coalesce(nullif(n->>'sellerName', ''), (select data->>'businessName' from docs where path = 'users/' || seller), 'The seller');
  buyer_name := coalesce(nullif(n->>'buyerName', ''), (select coalesce(nullif(data->>'businessName', ''), data->>'fullName') from docs where path = 'users/' || buyer), 'The buyer');

  if t = 'invoiceDeleteRequests' and n->>'status' = 'ACCEPTED' then
    -- GST month locked on either side → the approval itself is refused
    perform vt_assert_unlocked_for_request(n);
    -- the seller's invoice: by id, or (buyer's request) by the order it came from
    inv_path := null;
    if coalesce(n->>'invoiceId', '') <> '' then inv_path := 'users/' || seller || '/invoices/' || (n->>'invoiceId');
    elsif coalesce(n->>'orderId', '') <> '' then
      select path into inv_path from docs where col = 'users/' || seller || '/invoices' and data->>'sourceOrderId' = (n->>'orderId') limit 1;
    end if;
    if inv_path is not null then select data into inv from docs where path = inv_path; end if;
    if inv is not null then
      if inv->>'gstFiled' = 'true' then raise exception 'VT_DENIED: this invoice is already filed in a GST return'; end if;
      if coalesce(inv->>'deleted', 'false') <> 'true' then
        for it in select * from jsonb_array_elements(coalesce(inv->'items', '[]'::jsonb)) loop
          q := coalesce((it->>'qty')::numeric, 0);
          if coalesce(it->>'productId', '') <> '' and q <> 0 then
            perform vt_bump('users/' || seller || '/products/' || (it->>'productId'), q);
            perform vt_new_doc('users/' || seller || '/stockMovements', jsonb_build_object('type', 'sale-out', 'productId', it->>'productId',
              'productName', it->>'name', 'qty', q, 'date', vt_today(), 'note', 'Reversed: invoice ' || coalesce(inv->>'invoiceNo', '') || ' deleted (buyer approved)',
              'createdAt', vt_now_ts()));
          end if;
        end loop;
        perform vt_patch(inv_path, jsonb_build_object('deleted', true, 'deletedAt', vt_now_ts(), 'deletedByRequest', req_id));
      end if;
    end if;
    -- every buyer purchase made from this invoice / order (by id, order, invoice)
    if coalesce(n->>'orderId', '') <> '' then select data into ord from docs where path = 'marketplaceOrders/' || (n->>'orderId'); end if;
    for pur_path in
      select path from docs where col = 'users/' || buyer || '/buyerPurchases'
        and (path = 'users/' || buyer || '/buyerPurchases/' || coalesce(nullif(n->>'purchaseId', ''), '-')
             or path = 'users/' || buyer || '/buyerPurchases/' || coalesce(nullif(ord->>'buyerPurchaseId', ''), '-')
             or (coalesce(n->>'invoiceId', '') <> '' and (data->>'sellerInvoiceId' = (n->>'invoiceId') or data->>'invoiceId' = (n->>'invoiceId'))))
    loop
      select data into pur from docs where path = pur_path;
      if pur->>'gstFiled' = 'true' then raise exception 'VT_DENIED: the buyer already filed this purchase in a GST return'; end if;
      for it in select * from jsonb_array_elements(coalesce(pur->'items', '[]'::jsonb)) loop
        q := coalesce((it->>'qty')::numeric, 0);
        if coalesce(it->>'linkedSkuMappingId', '') <> '' and q <> 0 then
          perform vt_bump('users/' || buyer || '/buyerSkuMappings/' || (it->>'linkedSkuMappingId'), -q);
          perform vt_new_doc('users/' || buyer || '/buyerStockMovements', jsonb_build_object('type', 'purchase-in', 'mappingId', it->>'linkedSkuMappingId',
            'productName', it->>'name', 'qty', -q, 'date', coalesce(pur->>'date', vt_today()),
            'note', 'Reversed: seller invoice ' || coalesce(n->>'invoiceNo', '') || ' deleted (approved)', 'createdAt', vt_now_ts()));
        end if;
        if coalesce(it->>'linkedProductId', '') <> '' and q <> 0 then   -- legacy purchases
          perform vt_bump('users/' || buyer || '/products/' || (it->>'linkedProductId'), -q);
        end if;
      end loop;
      delete from docs where path = pur_path;
    end loop;
    perform vt_patch(new.path, jsonb_build_object('status', 'COMPLETED', 'completedAt', vt_now_ts()));

  elsif t = 'paymentConfirmations' then
    if n->>'status' = 'APPROVED' then
      rid := vt_new_doc('users/' || seller || '/receipts', jsonb_build_object(
        'customerId', coalesce(n->>'customerId', ''), 'customerName', coalesce(n->>'customerName', n->>'buyerName', 'Buyer'),
        'date', n->>'date', 'amount', n->'amount', 'mode', coalesce(n->>'mode', ''), 'note', coalesce(nullif(n->>'note', ''), 'Paid directly (confirmed)'),
        'sourceConfirmationId', req_id, 'linkedBuyerUid', buyer, 'buyerPaymentId', n->>'buyerPaymentId', 'createdAt', vt_now_ts()));
      perform vt_patch('users/' || buyer || '/buyerPayments/' || (n->>'buyerPaymentId'),
        jsonb_build_object('status', 'CONFIRMED', 'receiptId', rid, 'sellerUid', seller, 'confirmationId', req_id));
      perform vt_patch(new.path, jsonb_build_object('receiptId', rid));
    elsif n->>'status' in ('REJECTED', 'CANCELLED') then
      delete from docs where path = 'users/' || buyer || '/buyerPayments/' || (n->>'buyerPaymentId')
        and data->>'status' = 'PENDING_SELLER_CONFIRMATION';
    end if;

  elsif t = 'paymentDeleteRequests' and n->>'status' = 'ACCEPTED' then
    if coalesce(n->>'receiptId', '') <> '' then
      perform vt_patch('users/' || seller || '/receipts/' || (n->>'receiptId'), jsonb_build_object('deleted', true, 'deletedAt', vt_now_ts(), 'deletedByRequest', req_id));
    end if;
    if coalesce(n->>'buyerPaymentId', '') <> '' then
      perform vt_patch('users/' || buyer || '/buyerPayments/' || (n->>'buyerPaymentId'), jsonb_build_object('deleted', true, 'deletedAt', vt_now_ts(), 'deletedByRequest', req_id));
    end if;
    perform vt_patch(new.path, jsonb_build_object('status', 'COMPLETED', 'completedAt', vt_now_ts()));
  end if;

  -- 🔔 tell the person who asked how it ended (in their own account)
  if t = 'invoiceDeleteRequests' or t = 'paymentDeleteRequests' then
    asker := case when n->>'requestedBy' = 'buyer' then buyer else seller end;
    approver_name := case when n->>'requestedBy' = 'buyer' then seller_name else buyer_name end;
    what := case when t = 'invoiceDeleteRequests' then 'invoice ' || coalesce(nullif(n->>'invoiceNo', ''), '')
                 else 'payment of ₹' || coalesce(n->>'amount', '') || ' (' || coalesce(n->>'date', '') || ')' end;
    if n->>'status' = 'ACCEPTED' then
      perform vt_notify(asker, 'approved', '✅ ' || approver_name || ' approved — ' || what || ' deleted from both accounts.');
    elsif n->>'status' = 'REJECTED' then
      perform vt_notify(asker, 'rejected', '❌ ' || approver_name || ' rejected your request to delete ' || what || '. It stays on both sides.');
    elsif n->>'status' = 'CANCELLED' then
      perform vt_notify(case when asker = buyer then seller else buyer end, 'cancelled',
        'ℹ️ ' || case when asker = buyer then buyer_name else seller_name end || ' withdrew the request to delete ' || what || '.');
    end if;
  elsif t = 'paymentConfirmations' then
    if n->>'status' = 'APPROVED' then
      perform vt_notify(buyer, 'approved', '✅ ' || seller_name || ' confirmed your payment of ₹' || coalesce(n->>'amount', '') || ' (' || coalesce(n->>'date', '') || ').');
    elsif n->>'status' = 'REJECTED' then
      perform vt_notify(buyer, 'rejected', '❌ ' || seller_name || ' did not confirm your payment of ₹' || coalesce(n->>'amount', '') || ' (' || coalesce(n->>'date', '') || ') — it was removed.');
    end if;
  end if;

  perform set_config('vt.system', 'off', true);
  return new;
end $$;
drop trigger if exists docs_finalize on public.docs;
create trigger docs_finalize after update on public.docs
  for each row when (split_part(new.path, '/', 1) in ('invoiceDeleteRequests', 'paymentConfirmations', 'paymentDeleteRequests'))
  execute function public.vt_finalize_request();
revoke execute on function public.vt_finalize_request() from public;

-- ---------------------------------------------------------------------
-- Seller invoice → buyer: handled by the "Recorded by seller" order the
-- buyer confirms (Billing sends it for every invoice to a linked buyer), and
-- the buyer's purchase + stock use the INVOICE DATE. An earlier automatic
-- step (vt_invoice_to_buyer) duplicated that flow and is removed here; the
-- one-time clean-up below undoes any duplicate purchases it created.
-- ---------------------------------------------------------------------
drop trigger if exists docs_invoice_to_buyer on public.docs;
drop function if exists public.vt_invoice_to_buyer();

do $$
declare r record; it jsonb; q numeric; buyer text;
begin
  perform set_config('vt.system', 'on', true);
  -- (a) duplicates: an auto purchase for an invoice that also has a buyer order
  for r in
    select p.path, p.data, split_part(p.path, '/', 2) as uid from public.docs p
    where p.path ~ '^users/[^/]+/buyerPurchases/' and p.data->>'autoCreatedFromInvoice' = 'true'
      and exists (select 1 from public.docs o where o.path like 'marketplaceOrders/%' and o.data->>'invoiceId' = p.data->>'invoiceId')
  loop
    buyer := r.uid;
    for it in select * from jsonb_array_elements(coalesce(r.data->'items', '[]'::jsonb)) loop
      q := coalesce((it->>'qty')::numeric, 0);
      if coalesce(it->>'linkedSkuMappingId', '') <> '' and q <> 0 then
        perform public.vt_bump('users/' || buyer || '/buyerSkuMappings/' || (it->>'linkedSkuMappingId'), -q);
        perform public.vt_new_doc('users/' || buyer || '/buyerStockMovements', jsonb_build_object('type', 'adjustment', 'mappingId', it->>'linkedSkuMappingId',
          'productName', it->>'name', 'qty', -q, 'date', r.data->>'date', 'note', 'Removed duplicate of invoice ' || coalesce(r.data->>'invoiceNo', '') || ' (counted via the seller''s order)', 'createdAt', public.vt_now_ts()));
      end if;
    end loop;
    delete from public.docs where path = r.path;
  end loop;
  -- (b) purchases made from an order: move them (and their stock movements)
  --     from the acceptance date to the seller's INVOICE date
  for r in
    select p.path, p.data, split_part(p.path, '/', 2) as uid, i.data->>'date' as inv_date from public.docs p
    join public.docs o on o.path = 'marketplaceOrders/' || (p.data->>'orderId')
    join public.docs i on i.path = 'users/' || (o.data->>'sellerUid') || '/invoices/' || (p.data->>'invoiceId')
    where p.path ~ '^users/[^/]+/buyerPurchases/' and p.data->>'autoCreatedFromOrder' = 'true'
      and coalesce(i.data->>'date', '') <> '' and p.data->>'date' is distinct from i.data->>'date'
      and coalesce(p.data->>'gstFiled', 'false') <> 'true'
      and public.vt_period_lock(split_part(p.path, '/', 2), p.data->>'date') is null
      and public.vt_period_lock(split_part(p.path, '/', 2), i.data->>'date') is null
  loop
    update public.docs set data = data || jsonb_build_object('date', r.inv_date), version = version + 1, updated_at = now()
     where col = 'users/' || r.uid || '/buyerStockMovements' and data->>'type' = 'purchase-in' and data->>'date' = r.data->>'date'
       and data->>'note' like '%(order ' || coalesce(r.data->>'orderNumber', '~') || ')%';
    update public.docs set data = data || jsonb_build_object('date', r.inv_date, 'invoiceDate', r.inv_date), version = version + 1, updated_at = now()
     where path = r.path;
  end loop;
  perform set_config('vt.system', 'off', true);
end $$;

grant execute on function public.vt_period_lock(text, text) to authenticated;

-- ---------------------------------------------------------------------
-- GST details of a LINKED partner (seller ↔ buyer): business name, GSTIN,
-- state, address. Needed so a seller's invoice to a registered buyer goes to
-- B2B (and reaches the buyer's GSTR-2B), and the buyer's purchase from the
-- seller counts for ITC. Only for an ACTIVE link, in either direction.
-- ---------------------------------------------------------------------
create or replace function public.vt_party_profile(p_uid text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me text := public.vt_uid(); d jsonb;
begin
  if me is null or coalesce(p_uid, '') = '' then return null; end if;
  if p_uid <> me and not (public.vt_link_active(me, p_uid) or public.vt_link_active(p_uid, me)) then return null; end if;
  select data into d from docs where path = 'users/' || p_uid;
  if d is null then return null; end if;
  return jsonb_build_object('businessName', coalesce(nullif(d->>'businessName', ''), d->>'fullName', ''),
    'gstin', upper(coalesce(d->>'gstin', '')), 'stateCode', coalesce(nullif(d->>'stateCode', ''), left(coalesce(d->>'gstin', ''), 2)),
    'state', coalesce(d->>'state', ''), 'address', coalesce(d->>'address', ''), 'email', coalesce(d->>'email', ''));
end $$;
revoke execute on function public.vt_party_profile(text) from public, anon;
grant execute on function public.vt_party_profile(text) to authenticated;

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
