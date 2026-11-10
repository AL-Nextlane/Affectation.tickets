-- =====================================================================
-- Reprise des données vers le nouveau projet Supabase
--
-- 1. ANCIEN projet > SQL Editor > New query : collez tout ce fichier, cliquez sur Run.
--    Le résultat est une seule case « script_a_coller » qui contient un long texte :
--    c'est le script d'import, avec toutes les données dedans. Copiez cette case.
-- 2. NOUVEAU projet (après supabase/schema.sql) > SQL Editor > New query :
--    collez le texte copié, cliquez sur Run.
--    Le résultat affiche le nombre de lignes reprises par table.
--
-- L'étape 1 ne modifie rien dans l'ancien projet.
-- L'étape 2 importe tout ou rien : en cas d'erreur, le nouveau projet reste vide.
-- Les comptes utilisateurs ne sont pas copiés : on les invite dans le nouveau projet,
-- et chacun y retrouve automatiquement son rôle (admin ou user).
-- =====================================================================

select replace($modele_r7w2$do $reprise$
declare
  d jsonb := $colle_9f4k$COLLEZ_ICI_LE_RESULTAT_DE_L_EXPORT$colle_9f4k$::jsonb;
  k text;
  n bigint;
begin
  if exists (select 1 from public.tickets) or exists (select 1 from public.sessions)
     or exists (select 1 from public.people) or exists (select 1 from public.self_tickets) then
    raise exception 'Le nouveau projet contient déjà des données : reprise annulée.';
  end if;
  delete from public.app_settings;
  insert into public.app_settings (id, columns, required, date_col, updated_at, updated_by)
  select id, coalesce(columns, '[]'), coalesce(required, '[]'), coalesce(date_col, -1), coalesce(updated_at, now()), updated_by
  from jsonb_to_recordset(d->'app_settings')
    as x(id int, columns jsonb, required jsonb, date_col int, updated_at timestamptz, updated_by uuid);
  insert into public.people (name, created_at, poles, archived)
  select name, coalesce(created_at, now()), coalesce(poles, '{}'), coalesce(archived, false)
  from jsonb_to_recordset(d->'people') as x(name text, created_at timestamptz, poles text[], archived boolean);
  insert into public.sessions (id, at, created_by, created_at)
  select id, at, created_by, coalesce(created_at, now())
  from jsonb_to_recordset(d->'sessions') as x(id text, at timestamptz, created_by uuid, created_at timestamptz);
  insert into public.tickets (id, seq, cells, assignee, note, assigned_at, session_id, archived_at, updated_at, updated_by)
  select id, seq, coalesce(cells, '[]'), assignee, note, assigned_at, session_id, archived_at, coalesce(updated_at, now()), updated_by
  from jsonb_to_recordset(d->'tickets')
    as x(id text, seq bigint, cells jsonb, assignee text, note text, assigned_at date, session_id text,
         archived_at timestamptz, updated_at timestamptz, updated_by uuid);
  perform setval(pg_get_serial_sequence('public.tickets', 'seq'), coalesce((select max(seq) from public.tickets), 0) + 1, false);
  insert into public.self_tickets (id, person, taken_on, label, created_at, created_by, pole, organisation, requester)
  select id, person, taken_on, label, coalesce(created_at, now()), created_by, pole, organisation, requester
  from jsonb_to_recordset(d->'self_tickets')
    as x(id text, person text, taken_on date, label text, created_at timestamptz, created_by uuid,
         pole text, organisation text, requester text);
  insert into public.client_orgs (org_key, org, client, updated_at, updated_by)
  select org_key, org, client, coalesce(updated_at, now()), updated_by
  from jsonb_to_recordset(d->'client_orgs')
    as x(org_key text, org text, client text, updated_at timestamptz, updated_by uuid);
  alter table public.audit_log disable trigger audit_log_stamp;
  insert into public.audit_log (id, at, user_id, user_email, action, details) overriding system value
  select id, at, user_id, user_email, action, coalesce(details, '{}')
  from jsonb_to_recordset(d->'audit_log')
    as x(id bigint, at timestamptz, user_id uuid, user_email text, action text, details jsonb);
  alter table public.audit_log enable trigger audit_log_stamp;
  perform setval(pg_get_serial_sequence('public.audit_log', 'id'), coalesce((select max(id) from public.audit_log), 0) + 1, false);
  foreach k in array array['app_settings', 'people', 'sessions', 'tickets', 'self_tickets', 'client_orgs', 'audit_log'] loop
    execute format('select count(*) from public.%I', k) into n;
    if n <> jsonb_array_length(d->k) then
      raise exception 'Table % : % lignes importées sur % exportées. Reprise annulée.', k, n, jsonb_array_length(d->k);
    end if;
  end loop;
  create table if not exists public.reprise_membres (email text primary key, role text not null);
  alter table public.reprise_membres enable row level security;
  insert into public.reprise_membres (email, role)
  select email, role from jsonb_to_recordset(d->'members') as x(email text, role text)
  on conflict (email) do update set role = excluded.role;
  execute $fn$
    create or replace function public.handle_new_user() returns trigger
    language plpgsql security definer set search_path = public as $$
    begin
      insert into public.members (user_id, email, role)
      values (new.id, new.email, coalesce((select r.role from public.reprise_membres r where lower(r.email) = lower(new.email)), 'user'))
      on conflict (user_id) do nothing;
      return new;
    end;
    $$
  $fn$;
end
$reprise$;
select 'Modèle de colonnes' as donnees, count(*) as lignes from public.app_settings
union all select 'Consultants', count(*) from public.people
union all select 'Sessions', count(*) from public.sessions
union all select 'Tickets (en cours + archives)', count(*) from public.tickets
union all select 'Tickets pris', count(*) from public.self_tickets
union all select 'Clients', count(*) from public.client_orgs
union all select 'Journal', count(*) from public.audit_log
union all select 'Comptes à inviter', count(*) from public.reprise_membres;$modele_r7w2$, 'COLLEZ_ICI_LE_RESULTAT_DE_L_EXPORT', jsonb_build_object(
  'app_settings', (select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from public.app_settings t),
  'people',       (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.name), '[]'::jsonb) from public.people t),
  'sessions',     (select coalesce(jsonb_agg(to_jsonb(t) order by t.at), '[]'::jsonb) from public.sessions t),
  'tickets',      (select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]'::jsonb) from public.tickets t),
  'self_tickets', (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at, t.id), '[]'::jsonb) from public.self_tickets t),
  'client_orgs',  (select coalesce(jsonb_agg(to_jsonb(t) order by t.org_key), '[]'::jsonb) from public.client_orgs t),
  'audit_log',    (select coalesce(jsonb_agg(to_jsonb(t) order by t.id), '[]'::jsonb) from public.audit_log t),
  'members',      (select coalesce(jsonb_agg(jsonb_build_object('email', email, 'role', role) order by email), '[]'::jsonb) from public.members)
)::text) as script_a_coller;
