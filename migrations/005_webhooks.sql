create table webhooks (
  id           uuid primary key,
  service_id   uuid not null references services(id),
  url          text not null,
  secret_enc   text not null,
  events       text[] not null,
  include_bots boolean not null default false,
  created_at   timestamptz not null default now(),
  disabled_at  timestamptz
);
create index webhooks_service_id_idx on webhooks (service_id, id desc);

create table webhook_deliveries (
  id              uuid primary key,
  webhook_id      uuid not null references webhooks(id),
  click_id        uuid not null,
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending', 'delivered', 'dead')),
  attempts        int not null default 0,
  next_attempt_at timestamptz default now(),
  last_status     int,
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz,
  unique (webhook_id, click_id)
);
create index webhook_deliveries_due_idx on webhook_deliveries (next_attempt_at) where status = 'pending';
create index webhook_deliveries_webhook_idx on webhook_deliveries (webhook_id, id desc);

-- Fan-out position in the clicks table. Starts now: webhooks never replay older clicks.
create table outbox_cursor (
  name            text primary key,
  last_click_id   uuid not null,
  last_clicked_at timestamptz not null
);
insert into outbox_cursor values ('webhooks', '00000000-0000-0000-0000-000000000000', now());
