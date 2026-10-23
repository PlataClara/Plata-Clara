-- Plata Clara: planes y suscripciones (Gratis / Plus / Familia).
-- Pégalo completo en Supabase > SQL Editor > New query > Run. Es seguro repetirlo.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'plus' check (plan in ('plus','family')),
  status text not null default 'active' check (status in ('active','past_due','canceled')),
  current_period_end timestamptz,   -- hasta cuándo está pagado
  grace_until timestamptz,          -- días de gracia si falló un cobro
  provider text,                    -- 'manual', más adelante 'culqi'
  provider_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;
drop policy if exists "ver mi suscripcion" on public.subscriptions;
create policy "ver mi suscripcion" on public.subscriptions for select using (auth.uid() = user_id);
-- Nadie puede cambiarse el plan desde la app: solo tú (SQL Editor) o la función de cobros.
revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;

-- Devuelve el plan vigente de la persona: pago activo, o prueba gratis de 14 días, o gratis.
create or replace function public.my_plan() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.subscriptions; created timestamptz;
begin
  select * into s from public.subscriptions where user_id = auth.uid();
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
revoke all on function public.my_plan() from public, anon;
grant execute on function public.my_plan() to authenticated;

-- ACTIVAR PLUS A MANO (por ejemplo, cuando alguien te paga por Yape).
-- Cambia el correo y los meses, y ejecuta solo este bloque:
--
-- insert into public.subscriptions (user_id, plan, status, current_period_end, provider)
-- select id, 'plus', 'active', now() + interval '1 month', 'manual'
-- from auth.users where email = 'correo@ejemplo.com'
-- on conflict (user_id) do update
--   set plan = 'plus', status = 'active',
--       current_period_end = excluded.current_period_end, updated_at = now();
