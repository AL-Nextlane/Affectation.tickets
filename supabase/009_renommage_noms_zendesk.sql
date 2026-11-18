-- 009 : aligne les noms des consultants sur leur nom Zendesk
--   « Maria Jose HERNANDEZ » → « Maria Jose HERNANDEZ FERNANDEZ »
--   « Jeannine FLORE »       → « Jeannine Flore Signing M. »
-- Renomme la personne (pôle et statut conservés), ses tickets (session en cours et archives) et ses tickets pris.
-- Tout ou rien : en cas d'erreur, rien n'est modifié.
-- L'historique (audit_log) garde les anciens noms, comme trace de ce qui s'est passé.

begin;

create temporary table renommage (ancien text primary key, nouveau text not null) on commit drop;
insert into renommage values
  ('Maria Jose HERNANDEZ', 'Maria Jose HERNANDEZ FERNANDEZ'),
  ('Jeannine FLORE',       'Jeannine Flore Signing M.');

update public.people       p set name     = r.nouveau from renommage r where p.name     = r.ancien;
update public.tickets      t set assignee = r.nouveau from renommage r where t.assignee = r.ancien;
update public.self_tickets s set person   = r.nouveau from renommage r where s.person   = r.ancien;

-- Contrôle : plus aucune trace des anciens noms (nb = 0), et les compteurs des nouveaux noms
select r.ancien || ' (ancien nom, doit être 0)' as controle,
       (select count(*) from public.people where name = r.ancien) +
       (select count(*) from public.tickets where assignee = r.ancien) +
       (select count(*) from public.self_tickets where person = r.ancien) as nb
from renommage r
union all
select r.nouveau || ' : liste / tickets / tickets pris',
       null
from renommage r
union all
select '   liste · ' || r.nouveau,        (select count(*) from public.people where name = r.nouveau) from renommage r
union all
select '   tickets · ' || r.nouveau,      (select count(*) from public.tickets where assignee = r.nouveau) from renommage r
union all
select '   tickets pris · ' || r.nouveau, (select count(*) from public.self_tickets where person = r.nouveau) from renommage r;

commit;
