-- Plata Clara: perfiles y permiso de padres (menores de 14).
-- Pégalo completo en Supabase > SQL Editor > New query > Run.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null,
  apellido text not null,
  genero text,
  fecha_nacimiento date not null,
  parent_email text,
  consent_status text not null default 'not_required'
    check (consent_status in ('not_required','pending','approved','rejected')),
  consent_token text,
  consent_sent_at timestamptz,
  consent_decided_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
drop policy if exists "ver mi perfil" on public.profiles;
create policy "ver mi perfil" on public.profiles for select using (auth.uid() = user_id);
-- Sin políticas de insert/update/delete: nadie desde la app puede cambiarse el estado a "aprobado".

-- La persona NO puede leer consent_token (si no, podría autorizarse sola).
revoke all on public.profiles from anon, authenticated;
grant select (user_id, nombre, apellido, genero, fecha_nacimiento, parent_email, consent_status, consent_sent_at)
  on public.profiles to authenticated;

-- Al crear la cuenta se arma el perfil a partir de los datos del registro.
alter table public.profiles add column if not exists terms_version text, add column if not exists terms_accepted_at timestamptz;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb); fn date; minor boolean;
begin
  if m ? 'fecha_nacimiento' then
    begin fn := (m->>'fecha_nacimiento')::date; exception when others then return new; end;
    minor := fn > (current_date - interval '14 years');
    insert into public.profiles(user_id, nombre, apellido, genero, fecha_nacimiento, parent_email, consent_status, terms_version, terms_accepted_at)
    values (new.id, left(coalesce(m->>'nombre',''),60), left(coalesce(m->>'apellido',''),60),
            left(coalesce(m->>'genero',''),20), fn,
            case when minor then left(m->>'parent_email',200) end,
            case when minor then 'pending' else 'not_required' end,
            left(m->>'terms_version',20), now())
    on conflict (user_id) do nothing;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();
