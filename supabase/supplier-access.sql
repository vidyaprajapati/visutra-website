-- =====================================================================
-- VISUTRA — SUPPLIER ACCESS
-- Run ONCE in Supabase → SQL Editor → New query, AFTER schema.sql.
-- Safe to re-run. IF YOU EVER RE-RUN schema.sql, RUN THIS FILE AGAIN
-- (schema.sql resets vt_new_signup to its original version).
--
-- What it does
--  1. A seller adds a supplier (with an email) in Billing → Supplier Master.
--  2. That supplier signs in at /billing/supplier/login.html with a one-time
--     link sent to THAT email address only (no password, no admin approval).
--  3. The supplier sees ONLY records where the supplier's email matches the
--     email on the seller's supplier card: purchases, payments, balance.
--  4. The supplier can also open the free tools.
--
-- Nothing in the existing `docs` security rules is loosened: the supplier
-- reads through ONE read-only function that returns a fixed set of fields.
-- =====================================================================

-- safe number reader (a stray text value can never break the dashboard)
create or replace function public.vt_num(j jsonb) returns numeric
language sql immutable as $$
  select case when jsonb_typeof(j) = 'number' then (j #>> '{}')::numeric else 0 end
$$;

-- Is this email on a supplier card of ANY seller?  (internal helper only)
create or replace function public.vt_is_supplier_email(p_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(btrim(p_email), '') <> '' and exists (
    select 1 from public.docs
    where col ~ '^users/[^/]+/suppliers$'
      and lower(btrim(coalesce(data->>'email', ''))) = lower(btrim(p_email))
  )
$$;
revoke execute on function public.vt_is_supplier_email(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 1) A new sign-up whose email is on a supplier card is APPROVED at once
--    (everyone else still starts PENDING, exactly as before).
--    The admin list shows decided_by = 'auto:supplier-invite' so you can
--    always spot these accounts and reject one if needed.
-- ---------------------------------------------------------------------
create or replace function public.vt_new_signup() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); s jsonb; auto boolean;
begin
  s := coalesce(m->'vt_signup', '{}'::jsonb);
  auto := public.vt_is_supplier_email(new.email);
  insert into public.account_approvals(uid, email, name, business_type, mobile, username, status, decided_at, decided_by)
  values (new.id, new.email, coalesce(s->>'fullName', m->>'full_name'),
          coalesce(s->>'businessType', case when auto then 'Supplier' end), s->>'mobileNumber', s->>'username',
          case when auto then 'APPROVED' else 'PENDING' end,
          case when auto then now() end,
          case when auto then 'auto:supplier-invite' end)
  on conflict (uid) do nothing;
  return new;
end $$;
drop trigger if exists vt_new_signup on auth.users;
create trigger vt_new_signup after insert on auth.users for each row execute function public.vt_new_signup();

-- ---------------------------------------------------------------------
-- 2) Seller saves / re-invites a supplier → if that email already has a
--    PENDING account, approve it. Only works for an email that is on one
--    of the CALLER'S OWN supplier cards. Never touches REJECTED accounts.
-- ---------------------------------------------------------------------
create or replace function public.vt_supplier_invite(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare me text := public.vt_uid(); e text := lower(btrim(coalesce(p_email, '')));
begin
  if me is null or e = '' then return; end if;
  if not public.vt_account_ok() then raise exception 'VT_DENIED: account not approved'; end if;
  if not exists (
    select 1 from public.docs
    where owner = me and col = 'users/' || me || '/suppliers'
      and lower(btrim(coalesce(data->>'email', ''))) = e
  ) then
    raise exception 'VT_DENIED: that email is not on one of your suppliers';
  end if;
  update public.account_approvals
     set status = 'APPROVED', decided_at = now(), decided_by = 'auto:supplier-invite'
   where lower(btrim(email)) = e and status = 'PENDING';
end $$;
revoke execute on function public.vt_supplier_invite(text) from public, anon;
grant execute on function public.vt_supplier_invite(text) to authenticated;

-- ---------------------------------------------------------------------
-- 3) The supplier's own dashboard data. Read-only. The signed-in email is
--    the ONLY key: no id is accepted from the browser, so a supplier cannot
--    ask for anyone else's records. (Sign-in needs a confirmed email — keep
--    "Confirm email" ON in Supabase → Authentication.)
--    Returns one entry per seller that listed this email as a supplier.
-- ---------------------------------------------------------------------
create or replace function public.vt_supplier_dashboard() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  e text := lower(btrim(coalesce(auth.jwt()->>'email', '')));
  r record; res jsonb := '[]'::jsonb; purchases jsonb; payments jsonb; tp numeric; tpaid numeric;
begin
  if auth.uid() is null or e = '' then raise exception 'VT_DENIED: sign in first'; end if;
  if not public.vt_account_ok() then raise exception 'VT_DENIED: account not approved'; end if;

  for r in
    select s.id as supplier_id, split_part(s.path, '/', 2) as seller_uid,
           coalesce(nullif(btrim(s.data->>'name'), ''), nullif(btrim(s.data->>'legalName'), ''), 'Supplier') as supplier_name,
           coalesce(s.data->>'phone', '') as phone,
           coalesce(nullif(btrim(u.data->>'businessName'), ''), nullif(btrim(u.data->>'fullName'), ''), 'Your buyer') as seller_name
      from public.docs s
      left join public.docs u on u.path = 'users/' || split_part(s.path, '/', 2)
     where s.col ~ '^users/[^/]+/suppliers$'
       and lower(btrim(coalesce(s.data->>'email', ''))) = e
     order by 5, 3
  loop
    select coalesce(jsonb_agg(jsonb_build_object(
             'date', p.data->>'date',
             'invoiceNo', coalesce(p.data->>'invoiceNo', ''),
             'subtotal', public.vt_num(p.data->'subtotal'),
             'gstTotal', public.vt_num(p.data->'gstTotal'),
             'grandTotal', public.vt_num(p.data->'grandTotal'),
             'items', (select coalesce(jsonb_agg(jsonb_build_object(
                         'name', it->>'name', 'qty', public.vt_num(it->'qty'), 'unit', coalesce(it->>'unit', ''),
                         'rate', public.vt_num(it->'rate'), 'gstRate', public.vt_num(it->'gstRate'),
                         'priceMode', coalesce(it->>'priceMode', ''), 'total', public.vt_num(it->'total'))), '[]'::jsonb)
                       from jsonb_array_elements(case when jsonb_typeof(p.data->'items') = 'array' then p.data->'items' else '[]'::jsonb end) it)
           ) order by p.data->>'date' desc, p.created_at desc), '[]'::jsonb),
           coalesce(sum(public.vt_num(p.data->'grandTotal')), 0)
      into purchases, tp
      from public.docs p
     where p.col = 'users/' || r.seller_uid || '/purchases'
       and p.data->>'supplierId' = r.supplier_id
       and coalesce(p.data->>'deleted', 'false') <> 'true';

    select coalesce(jsonb_agg(jsonb_build_object(
             'date', y.data->>'date', 'amount', public.vt_num(y.data->'amount'),
             'mode', coalesce(y.data->>'mode', ''), 'note', coalesce(y.data->>'note', '')
           ) order by y.data->>'date' desc, y.created_at desc), '[]'::jsonb),
           coalesce(sum(public.vt_num(y.data->'amount')), 0)
      into payments, tpaid
      from public.docs y
     where y.col = 'users/' || r.seller_uid || '/payments'
       and y.data->>'supplierId' = r.supplier_id
       and coalesce(y.data->>'deleted', 'false') <> 'true';

    res := res || jsonb_build_array(jsonb_build_object(
      'sellerName', r.seller_name, 'supplierName', r.supplier_name, 'phone', r.phone,
      'totalPurchase', tp, 'totalPaid', tpaid, 'balance', tp - tpaid,
      'purchases', purchases, 'payments', payments));
  end loop;
  return res;
end $$;
revoke execute on function public.vt_supplier_dashboard() from public, anon;
grant execute on function public.vt_supplier_dashboard() to authenticated;
