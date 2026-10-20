-- Plata Clara: tabla de datos por usuario con seguridad (RLS).
-- Pégalo completo en Supabase > SQL Editor > New query > Run.

create table if not exists public.user_data (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  data       jsonb       not null,
  updated_at timestamptz not null default now()
);

alter table public.user_data enable row level security;

-- Cada persona solo puede ver y modificar SU propia fila.
drop policy if exists "leer lo propio"      on public.user_data;
drop policy if exists "crear lo propio"     on public.user_data;
drop policy if exists "actualizar lo propio" on public.user_data;
drop policy if exists "borrar lo propio"    on public.user_data;

create policy "leer lo propio"       on public.user_data for select using (auth.uid() = user_id);
create policy "crear lo propio"      on public.user_data for insert with check (auth.uid() = user_id);
create policy "actualizar lo propio" on public.user_data for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "borrar lo propio"     on public.user_data for delete using (auth.uid() = user_id);
