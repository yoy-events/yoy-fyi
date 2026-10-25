-- Visits to the public pages (home, blog, docs, bio pages, crawler files): no IP, no cookies.
-- Shows whether people arrive from AI chats and search, and which crawlers read the site.
create table page_views (
  id          uuid primary key,
  at          timestamptz not null,
  path        text not null,
  referer_host text,
  source      text not null check (source in ('ai_chat', 'search', 'social', 'direct', 'other', 'internal')),
  bot_name    text -- null for people
);
create index page_views_at_idx on page_views (at);
