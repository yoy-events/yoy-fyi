alter table links
  add column title            text,
  add column tags             text[] not null default '{}',
  add column ext_service      text,
  add column ext_entity_type  text,
  add column ext_entity_id    text,
  add column idempotency_key  text,
  add column idempotency_hash text;

create unique index links_idempotency_key_idx on links (service_id, idempotency_key)
  where idempotency_key is not null;
create unique index links_external_ref_idx on links (service_id, ext_service, ext_entity_type, ext_entity_id)
  where ext_service is not null;
create index links_service_id_idx on links (service_id, id desc);
