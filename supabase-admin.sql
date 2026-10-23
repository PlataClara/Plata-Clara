-- Plata Clara: panel de administrador + plan "De por vida".
-- Ejecuta ANTES supabase-planes.sql. Pega esto completo en SQL Editor > Run. Es seguro repetirlo.

alter table public.subscriptions drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check check (plan in ('plus','family','lifetime'));

-- Quién es administrador (solo se llena desde el SQL Editor; nadie puede hacerse admin desde la app).
create table if not exists public.admins (user_id uuid primary key references auth.users(id) on delete cascade);
alter table public.admins enable row level security;
revoke all on public.admins from anon, authenticated;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from public.admins where user_id = auth.uid()) $$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- Plan vigente (ahora entiende "De por vida").
create or replace function public.my_plan() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.subscriptions; created timestamptz;
begin
  select * into s from public.subscriptions where user_id = auth.uid();
  if found and s.plan = 'lifetime' and s.status = 'active' then
    return jsonb_build_object('plan', 'lifetime', 'trial', false, 'status', 'active');
  end if;
  if found and (coalesce(s.current_period_end, '-infinity') > now()
                or (s.status = 'past_due' and coalesce(s.grace_until, '-infinity') > now())) then
    return jsonb_build_object('plan', s.plan, 'trial', false, 'status', s.status,
                              'until', greatest(s.current_period_end, s.grace_until));
  end if;
  select u.created_at into created from auth.users u where u.id = auth.uid();
  if created is not null and created + interval '14 days' > now() then
    return jsonb_build_object('plan', 'plus', 'trial', true, 'until', created + interval '14 days');
  end if;
  return jsonb_build_object('plan', 'free', 'trial', false);
end $$;

-- Activar / extender / quitar un plan (solo administradores).
create or replace function public.admin_set_plan(p_email text, p_plan text, p_months int default 1) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; base timestamptz;
begin
  if not public.is_admin() then raise exception 'no autorizado'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then return jsonb_build_object('error', 'no_user'); end if;
  if p_plan = 'free' then
    delete from public.subscriptions where user_id = uid;
    return jsonb_build_object('ok', true);
  end if;
  if p_plan not in ('plus','family','lifetime') then return jsonb_build_object('error', 'bad_plan'); end if;
  if p_plan = 'lifetime' then
    insert into public.subscriptions(user_id, plan, status, current_period_end, provider)
    values (uid, 'lifetime', 'active', null, 'manual')
    on conflict (user_id) do update set plan = 'lifetime', status = 'active', current_period_end = null, provider = 'manual', updated_at = now();
  else
    select greatest(now(), coalesce(max(current_period_end), now())) into base from public.subscriptions where user_id = uid;
    insert into public.subscriptions(user_id, plan, status, current_period_end, provider)
    values (uid, p_plan, 'active', base + (greatest(coalesce(p_months,1),1) * interval '1 month'), 'manual')
    on conflict (user_id) do update set plan = p_plan, status = 'active',
      current_period_end = base + (greatest(coalesce(p_months,1),1) * interval '1 month'), provider = 'manual', updated_at = now();
  end if;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.admin_set_plan(text, text, int) from public, anon;
grant execute on function public.admin_set_plan(text, text, int) to authenticated;

-- Lista de cuentas con plan (solo administradores).
create or replace function public.admin_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'no autorizado'; end if;
  return coalesce((select jsonb_agg(x) from (
    select u.email, s.plan, s.status, case when s.plan = 'lifetime' then null else s.current_period_end end as until
    from public.subscriptions s join auth.users u on u.id = s.user_id
    order by s.updated_at desc limit 200) x), '[]'::jsonb);
end $$;
revoke all on function public.admin_list() from public, anon;
grant execute on function public.admin_list() to authenticated;

-- HAZTE ADMINISTRADOR (cambia el correo por el TUYO y ejecuta solo esta línea):
-- insert into public.admins(user_id) select id from auth.users where email = 'TU_CORREO@gmail.com' on conflict do nothing;
