-- 009 : aligne les noms des consultants sur leur nom Zendesk
--   « Maria Jose HERNANDEZ » → « Maria Jose HERNANDEZ FERNANDEZ »
--   « Jeannine FLORE »       → « Jeannine Flore Signing M. »
-- et ajoute « Nuno ALMEIDA CORREIA » (APV), archivé car il a quitté l'équipe.
-- Renomme la personne (pôle et statut conservés), ses tickets (session en cours et archives) et ses tickets pris.
-- Sans table temporaire : le SQL Editor de Supabase peut exécuter chaque instruction sur une connexion différente.
-- Le script peut être relancé sans risque (une deuxième exécution ne change plus rien).
-- L'historique (audit_log) garde les anciens noms, comme trace de ce qui s'est passé.

begin;

update public.people p set name = r.nouveau
from (values ('Maria Jose HERNANDEZ', 'Maria Jose HERNANDEZ FERNANDEZ'),
             ('Jeannine FLORE',       'Jeannine Flore Signing M.')) as r(ancien, nouveau)
where p.name = r.ancien;

update public.tickets t set assignee = r.nouveau
from (values ('Maria Jose HERNANDEZ', 'Maria Jose HERNANDEZ FERNANDEZ'),
             ('Jeannine FLORE',       'Jeannine Flore Signing M.')) as r(ancien, nouveau)
where t.assignee = r.ancien;

update public.self_tickets s set person = r.nouveau
from (values ('Maria Jose HERNANDEZ', 'Maria Jose HERNANDEZ FERNANDEZ'),
             ('Jeannine FLORE',       'Jeannine Flore Signing M.')) as r(ancien, nouveau)
where s.person = r.ancien;

-- Nuno ALMEIDA CORREIA : parti, ajouté directement en archivé (pôle APV) pour que ses tickets pris
-- importés depuis Zendesk soient reconnus et comptés dans les statistiques
insert into public.people (name, poles, archived)
values ('Nuno ALMEIDA CORREIA', array['APV'], true)
on conflict (name) do update set poles = excluded.poles, archived = true;

commit;

-- Contrôle (attendu : anciens noms 0 ; Maria Jose 1 / 1 / 32 ; Jeannine 1 / 1 / 0 ; Nuno 1 / 0 / 0, archivé APV)
select r.nom,
       (select count(*) from public.people       where name     = r.nom) as liste,
       (select count(*) from public.tickets      where assignee = r.nom) as tickets,
       (select count(*) from public.self_tickets where person   = r.nom) as tickets_pris,
       (select archived::text || ' · ' || array_to_string(poles, ',') from public.people where name = r.nom) as statut
from (values ('Maria Jose HERNANDEZ'), ('Jeannine FLORE'),
             ('Maria Jose HERNANDEZ FERNANDEZ'), ('Jeannine Flore Signing M.'), ('Nuno ALMEIDA CORREIA')) as r(nom);
