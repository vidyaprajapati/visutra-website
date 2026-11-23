-- =====================================================================
-- VISUTRA — ADMIN (no Google Script). Run ONCE in Supabase → SQL Editor.
-- 1) Change the email below to YOUR admin login email, then Run.
-- 2) Safe to re-run. Re-run after schema.sql if you ever re-run that.
-- Admin signs in at /billing/login.html (same as everyone) and then opens
-- /billing/admin-approvals.html (approve/reject accounts, manage admins)
-- and /admin.html (shop products).
-- =====================================================================
insert into public.store_admins(email) values (lower('support@visutra.in')) on conflict do nothing;

-- if that account already exists and is stuck PENDING, approve it now
update public.account_approvals set status = 'APPROVED', decided_at = now(), decided_by = 'auto:admin'
 where lower(email) in (select lower(email) from public.store_admins) and status <> 'APPROVED';

-- (admins are always treated as approved by schema.sql — nothing to do here)

-- admin list / add / remove (admins only; you can't remove the last admin)
create or replace function public.vt_admin_list() returns setof text
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.vt_is_store_admin() then raise exception 'VT_DENIED: admins only'; end if;
  return query select email from public.store_admins order by email;
end $$;
create or replace function public.vt_admin_add(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.vt_is_store_admin() then raise exception 'VT_DENIED: admins only'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'VT_BAD_EMAIL'; end if;
  insert into public.store_admins(email) values (e) on conflict do nothing;
  update public.account_approvals set status = 'APPROVED', decided_at = now(), decided_by = auth.jwt()->>'email'
   where lower(email) = e and status <> 'APPROVED';
end $$;
create or replace function public.vt_admin_remove(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare e text := lower(btrim(coalesce(p_email, '')));
begin
  if not public.vt_is_store_admin() then raise exception 'VT_DENIED: admins only'; end if;
  if (select count(*) from public.store_admins) <= 1 then raise exception 'VT_LAST_ADMIN: keep at least one admin'; end if;
  delete from public.store_admins where lower(email) = e;
end $$;
revoke execute on function public.vt_admin_list(), public.vt_admin_add(text), public.vt_admin_remove(text) from public, anon;
grant execute on function public.vt_admin_list(), public.vt_admin_add(text), public.vt_admin_remove(text) to authenticated;
