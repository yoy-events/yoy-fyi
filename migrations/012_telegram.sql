-- The Telegram bot (ADR-0006): a user connects one Telegram account through a one-time /start
-- token and then shortens links by sending them to the bot.
alter table users add column telegram_user_id bigint unique;

create table telegram_connect_tokens (
  token_hash text primary key,
  user_id    uuid not null references users (id),
  expires_at timestamptz not null,
  used_at    timestamptz
);

alter table links drop constraint links_created_via_check;
alter table links add constraint links_created_via_check check (created_via in ('api', 'admin', 'mcp', 'web', 'telegram'));
