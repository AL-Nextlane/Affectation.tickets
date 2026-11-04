-- =====================================================================
-- Mise à jour 008 : note libre sur les tickets
-- À exécuter une seule fois dans Supabase > SQL Editor > New query (réexécutable sans erreur).
-- La note se saisit dans l'onglet Tickets et reste consultable dans les archives.
-- =====================================================================

alter table public.tickets
  add column if not exists note text;
