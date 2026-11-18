-- =====================================================================
-- Mise à jour 010 : groupes clients Zendesk (tag « grp_c… » des organisations)
-- À exécuter une seule fois dans Supabase > SQL Editor > New query.
--
-- org_groups : groupe Zendesk de chaque organisation déjà interrogée (cache, pour ne pas
--              redemander à Zendesk à chaque fois). grp vide = organisation sans groupe ou introuvable.
-- Le rattachement « groupe → client » est enregistré dans client_orgs, avec une clé « grp:grp_c100517 ».
-- =====================================================================

create table if not exists public.org_groups (
  org_key    text primary key,              -- nom de l'organisation normalisé (comme client_orgs.org_key)
  org        text not null,                 -- nom de l'organisation tel qu'affiché
  grp        text,                          -- code du groupe Zendesk (ex. grp_c100517), vide si aucun
  grp_name   text,                          -- nom proposé pour le groupe (ex. MAURIN)
  checked_at timestamptz not null default now()
);
create index if not exists org_groups_grp_idx on public.org_groups (grp);

alter table public.org_groups enable row level security;

drop policy if exists org_groups_select on public.org_groups;
drop policy if exists org_groups_insert on public.org_groups;
drop policy if exists org_groups_update on public.org_groups;
drop policy if exists org_groups_delete on public.org_groups;
create policy org_groups_select on public.org_groups for select to authenticated using (public.is_member());
create policy org_groups_insert on public.org_groups for insert to authenticated with check (public.is_member());
create policy org_groups_update on public.org_groups for update to authenticated
  using (public.is_member()) with check (public.is_member());
create policy org_groups_delete on public.org_groups for delete to authenticated using (public.is_member());

-- Contrôle : la table existe et est vide au premier passage
select count(*) as organisations_en_cache from public.org_groups;
