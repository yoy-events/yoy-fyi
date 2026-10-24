-- Custom social preview of a short link: { title, description?, image? } (Open Graph).
alter table links add column preview jsonb;
