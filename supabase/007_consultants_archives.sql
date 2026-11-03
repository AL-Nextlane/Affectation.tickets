-- =====================================================================
-- Mise à jour 007 : archivage des consultants
-- À exécuter une seule fois dans Supabase > SQL Editor > New query (réexécutable sans erreur).
-- Un consultant archivé n'est plus proposé à l'affectation ; il reste dans les archives et les statistiques.
-- =====================================================================

alter table public.people
  add column if not exists archived boolean not null default false;
