-- =====================================================================
-- Mise à jour 006 : regroupement des organisations par client
-- À exécuter une seule fois dans Supabase > SQL Editor > New query.
-- Une ligne par organisation rattachée à un client ; une organisation n'a qu'un client.
-- =====================================================================

create table if not exists public.client_orgs (
  org_key    text primary key,               -- nom de l'organisation normalisé (minuscules, sans accents)
  org        text not null,                  -- nom de l'organisation tel qu'affiché
  client     text not null,                  -- nom du client (ex. CHOPARD)
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table public.client_orgs enable row level security;

drop policy if exists client_orgs_select on public.client_orgs;
drop policy if exists client_orgs_insert on public.client_orgs;
drop policy if exists client_orgs_update on public.client_orgs;
drop policy if exists client_orgs_delete on public.client_orgs;
create policy client_orgs_select on public.client_orgs for select to authenticated using (public.is_member());
create policy client_orgs_insert on public.client_orgs for insert to authenticated with check (public.is_member());
create policy client_orgs_update on public.client_orgs for update to authenticated
  using (public.is_member()) with check (public.is_member());
create policy client_orgs_delete on public.client_orgs for delete to authenticated using (public.is_member());

alter publication supabase_realtime add table public.client_orgs;
