-- 009 : aligne le nom de Maria Jose sur son nom Zendesk (« Maria Jose HERNANDEZ FERNANDEZ »)
-- Renomme la personne (pôle et statut conservés), ses tickets (session en cours et archives) et ses tickets pris.
-- Tout ou rien : en cas d'erreur, rien n'est modifié.
-- L'historique (audit_log) garde l'ancien nom, comme trace de ce qui s'est passé.

begin;

update public.people       set name     = 'Maria Jose HERNANDEZ FERNANDEZ' where name     = 'Maria Jose HERNANDEZ';
update public.tickets      set assignee = 'Maria Jose HERNANDEZ FERNANDEZ' where assignee = 'Maria Jose HERNANDEZ';
update public.self_tickets set person   = 'Maria Jose HERNANDEZ FERNANDEZ' where person   = 'Maria Jose HERNANDEZ';

-- Contrôle : plus aucune trace de l'ancien nom, et les compteurs du nouveau nom
select 'reste ancien nom' as controle,
       (select count(*) from public.people       where name     = 'Maria Jose HERNANDEZ') +
       (select count(*) from public.tickets      where assignee = 'Maria Jose HERNANDEZ') +
       (select count(*) from public.self_tickets where person   = 'Maria Jose HERNANDEZ') as nb
union all select 'liste',        count(*) from public.people       where name     = 'Maria Jose HERNANDEZ FERNANDEZ'
union all select 'tickets',      count(*) from public.tickets      where assignee = 'Maria Jose HERNANDEZ FERNANDEZ'
union all select 'tickets pris', count(*) from public.self_tickets where person   = 'Maria Jose HERNANDEZ FERNANDEZ';

commit;
