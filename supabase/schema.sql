-- ═══════════════════════════════════════════════════════════════
-- Ploeggenoten Marketingbord — schema
-- Draaien in: Supabase SQL Editor (project gyhrwjdlwamyjhxtdypw)
-- Veilig om opnieuw te draaien (idempotent).
-- ═══════════════════════════════════════════════════════════════

create table if not exists mkt_posts (
  id                text primary key,
  titel             text not null default '',
  kanaal            text not null default '',
  format            text not null default '',
  doel              text not null default '',
  fase              text not null default 'Idee',
  campagne          text not null default '',
  vacature          text not null default '',
  utm               text not null default '',
  hook              text not null default '',
  script            text not null default '',
  publicatie_datum  date,
  publicatie_tijd   text not null default '',
  link              text not null default '',
  resultaat         jsonb not null default '{}',
  learnings         text not null default '',
  notities          jsonb not null default '[]',
  created_at        timestamptz not null default now(),
  updated_by        uuid,
  updated_at        timestamptz not null default now()
);

create table if not exists mkt_kanalen (
  naam     text primary key,
  kleur    text not null default '#5b8bbf',
  volgorde int  not null default 0
);

-- Live Meta-advertentiecijfers (gevuld door de fase 2-Edge Function 'meta-sync';
-- de app leest alleen — schrijven gebeurt server-side met de service-role key)
create table if not exists mkt_meta_stats (
  id          bigint generated always as identity primary key,
  datum       date not null,
  campagne    text not null default '',
  advertentie text not null default '',
  uitgegeven  numeric not null default 0,
  impressies  int not null default 0,
  kliks       int not null default 0,
  leads       int not null default 0,
  bereik      int not null default 0,
  synced_at   timestamptz not null default now(),
  unique (datum, campagne, advertentie)
);

-- Bestaat de tabel al van een eerdere run? Voeg nieuwe kolommen toe.
alter table mkt_posts add column if not exists vacature text not null default '';
alter table mkt_posts add column if not exists utm text not null default '';

-- Besluiten van de advertentie-waakhond (Bryan beslist; app adviseert alleen)
create table if not exists mkt_ad_besluiten (
  id          bigint generated always as identity primary key,
  advertentie text not null,
  campagne    text not null default '',
  besluit     text not null,               -- 'stop' | 'negeer' | 'opschalen'
  status      text not null default 'open',-- 'open' | 'bevestigd'
  door        text not null default '',
  note        text not null default '',
  created_at  timestamptz not null default now()
);

-- ── RLS: hele team (zelfde model als het pijplijnbord) ──────────
do $$
declare t text;
begin
  foreach t in array array['mkt_posts','mkt_kanalen','mkt_meta_stats','mkt_ad_besluiten'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists mkt_team on %I', t);
    execute format(
      'create policy mkt_team on %I for all to authenticated
       using (true) with check (true)', t);
  end loop;
end $$;

-- ── Realtime ────────────────────────────────────────────────────
do $$
begin
  begin
    alter publication supabase_realtime add table mkt_posts;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table mkt_kanalen;
  exception when duplicate_object then null;
  end;
end $$;

-- ── Startkanalen ────────────────────────────────────────────────
insert into mkt_kanalen (naam, kleur, volgorde) values
  ('Instagram', '#b23b8f', 1),
  ('Facebook',  '#1877f2', 2),
  ('TikTok',    '#20262e', 3),
  ('LinkedIn',  '#0a66c2', 4)
on conflict (naam) do nothing;
