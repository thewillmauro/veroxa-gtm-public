-- M6: the HubSpot deal created when a firm replies (SPEC §10). Unique like
-- hubspot_company_id / hubspot_contact_id (init schema), so two firms can
-- never point at the same deal. NULL means no deal yet.

alter table public.firms add column hubspot_deal_id text unique;
