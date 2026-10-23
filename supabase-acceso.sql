-- Plata Clara: acceso privado con pago unico. Pegar TODO en SQL Editor y Run.
drop function if exists public.my_plan();
drop function if exists public.admin_set_plan(text, text, int);
drop function if exists public.admin_list();
drop table if exists public.subscriptions;

create table if not exists public.admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;
create or replace function public.is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.admins where user_id = auth.uid()) $$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

create table if not exists public.access_list (
  email text primary key, note text, granted_at timestamptz not null default now());
alter table public.access_list enable row level security;
revoke all on public.access_list from anon, authenticated;

create or replace function public.can_register(p_email text) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.access_list where email = lower(trim(p_email))) $$;
grant execute on function public.can_register(text) to anon, authenticated;

create or replace function public.check_access_on_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.access_list where email = lower(trim(new.email))) then
    raise exception 'sin_acceso';
  end if;
  return new;
end $$;
drop trigger if exists check_access_before_signup on auth.users;
create trigger check_access_before_signup before insert on auth.users
  for each row execute function public.check_access_on_signup();

create or replace function public.admin_access_add(p_email text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'no autorizado'; end if;
  if p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then return jsonb_build_object('error', 'bad_email'); end if;
  insert into public.access_list(email, note) values (lower(trim(p_email)), left(p_note, 60))
  on conflict (email) do update set note = coalesce(excluded.note, public.access_list.note);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.admin_access_add(text, text) from public, anon;
grant execute on function public.admin_access_add(text, text) to authenticated;

create or replace function public.admin_access_remove(p_email text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'no autorizado'; end if;
  delete from public.access_list where email = lower(trim(p_email));
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.admin_access_remove(text) from public, anon;
grant execute on function public.admin_access_remove(text) to authenticated;

create or replace function public.admin_access_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'no autorizado'; end if;
  return coalesce((select jsonb_agg(x) from (
    select a.email, a.note, a.granted_at,
           exists (select 1 from auth.users u where lower(u.email) = a.email) as registered
    from public.access_list a order by a.granted_at desc limit 300) x), '[]'::jsonb);
end $$;
revoke all on function public.admin_access_list() from public, anon;
grant execute on function public.admin_access_list() to authenticated;
