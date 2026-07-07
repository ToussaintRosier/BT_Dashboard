-- ============================================================================
-- KPI Dashboard — Supabase database schema
-- ============================================================================
-- Plak dit volledige bestand in: Supabase project > SQL Editor > New query > Run
-- Dit maakt alle tabellen, regels (Row Level Security) en koppelt automatisch
-- elke nieuwe inlog aan een profiel.
-- ============================================================================

-- 1. PROFIELEN (koppelt een login aan een naam + rol) ------------------------
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  naam        text not null,            -- bv. 'Jelle van Schijndel'
  rol         text not null check (rol in ('bm', 'manager')),
  bm_naam     text,                     -- moet exact overeenkomen met naam in kpi_weekly/pipeline_cards (null voor manager-only accounts)
  doel        int,                      -- jaarnorm starters (alleen voor bm)
  kleur       text,                     -- hex kleur voor grafieken
  created_at  timestamptz default now()
);

alter table profiles enable row level security;

-- Helper-functies (security definer = lopen buiten RLS om, dus geen
-- recursie als een policy op profiles zelf moet checken of iemand manager is)
create or replace function is_manager() returns boolean as $$
  select exists (select 1 from profiles where id = auth.uid() and rol = 'manager');
$$ language sql security definer stable;

create or replace function my_bm_naam() returns text as $$
  select bm_naam from profiles where id = auth.uid();
$$ language sql security definer stable;

-- Iedereen mag zijn eigen profiel lezen; managers mogen alle profielen lezen
drop policy if exists "profiel: zelf lezen" on profiles;
create policy "profiel: zelf lezen" on profiles
  for select using (auth.uid() = id);

drop policy if exists "profiel: manager leest alles" on profiles;
create policy "profiel: manager leest alles" on profiles
  for select using (is_manager());

-- 2. KPI-WEEKDATA (intakes, bezoeken, aanbiedingen, matchgesprekken, starters) -
create table if not exists kpi_weekly (
  id              bigint generated always as identity primary key,
  bm_naam         text not null,
  jaar            int  not null,
  week            int  not null,
  intakes         int  default 0,
  bezoeken        int  default 0,
  aanbiedingen    int  default 0,
  matchgesprekken int  default 0,
  contractvoorstellen numeric(6,1) default 0,  -- 0,5-stappen mogelijk bij gedeelde plaatsingen
  starters        numeric(6,1) default 0,  -- 0,5-stappen mogelijk bij gedeelde plaatsingen
  updated_by      uuid references auth.users(id),
  updated_at      timestamptz default now(),
  unique (bm_naam, jaar, week)
);

-- Bestond de tabel al van vóór deze update met 'starters int'? Dan toch ombouwen
-- naar numeric, zodat gedeelde plaatsingen (0,5) opgeslagen kunnen worden.
alter table kpi_weekly alter column starters type numeric(6,1);

-- Bestond de tabel al van vóór de invoering van de 6e KPI 'Contractvoorstellen'?
-- Dan deze kolom alsnog toevoegen (bestaande data blijft intact).
alter table kpi_weekly add column if not exists contractvoorstellen numeric(6,1) default 0;

alter table kpi_weekly enable row level security;

drop policy if exists "kpi: manager ziet alles" on kpi_weekly;
create policy "kpi: manager ziet alles" on kpi_weekly
  for select using (is_manager());

drop policy if exists "kpi: bm ziet eigen data" on kpi_weekly;
create policy "kpi: bm ziet eigen data" on kpi_weekly
  for select using (bm_naam = my_bm_naam());

drop policy if exists "kpi: bm voert eigen data in" on kpi_weekly;
create policy "kpi: bm voert eigen data in" on kpi_weekly
  for insert with check (bm_naam = my_bm_naam());

drop policy if exists "kpi: manager voert in" on kpi_weekly;
create policy "kpi: manager voert in" on kpi_weekly
  for insert with check (is_manager());

drop policy if exists "kpi: bm wijzigt eigen data" on kpi_weekly;
create policy "kpi: bm wijzigt eigen data" on kpi_weekly
  for update using (bm_naam = my_bm_naam());

drop policy if exists "kpi: manager wijzigt alles" on kpi_weekly;
create policy "kpi: manager wijzigt alles" on kpi_weekly
  for update using (is_manager());

-- 3. PIPELINE / KANBAN KAARTEN ------------------------------------------------
create table if not exists pipeline_cards (
  id              uuid primary key default gen_random_uuid(),
  bm_naam         text not null,
  naam            text not null,           -- naam kandidaat
  notitie         text,
  stage           text not null,           -- Intake / Bezoeken / Aanbieden / Matchgesprekken / Contractvoorstel / Starter
  week            int  not null,
  jaar            int  not null,
  aanb            int,                     -- aantal aanbiedingen (alleen relevant in stage 'Aanbieden')
  functie         text,                    -- functietitel kandidaat (ingevuld bij Intake)
  salarisindicatie text,                   -- afgekort 'SI' in de UI
  regio           text,                    -- Noord / Midden / Zuid
  gesprek         smallint,                -- 1, 2 of 3 (1e/2e/3e gesprek, alleen relevant in stage 'Matchgesprekken')
  datum           date default current_date,
  updated_by      uuid references auth.users(id),
  updated_at      timestamptz default now()
);

alter table pipeline_cards enable row level security;

drop policy if exists "pipeline: manager ziet alles" on pipeline_cards;
create policy "pipeline: manager ziet alles" on pipeline_cards
  for select using (is_manager());

drop policy if exists "pipeline: bm ziet eigen kaarten" on pipeline_cards;
create policy "pipeline: bm ziet eigen kaarten" on pipeline_cards
  for select using (bm_naam = my_bm_naam());

drop policy if exists "pipeline: bm voegt eigen kaarten toe" on pipeline_cards;
create policy "pipeline: bm voegt eigen kaarten toe" on pipeline_cards
  for insert with check (bm_naam = my_bm_naam());

drop policy if exists "pipeline: manager voegt toe" on pipeline_cards;
create policy "pipeline: manager voegt toe" on pipeline_cards
  for insert with check (is_manager());

drop policy if exists "pipeline: bm wijzigt eigen kaarten" on pipeline_cards;
create policy "pipeline: bm wijzigt eigen kaarten" on pipeline_cards
  for update using (bm_naam = my_bm_naam());

drop policy if exists "pipeline: bm verwijdert eigen kaarten" on pipeline_cards;
create policy "pipeline: bm verwijdert eigen kaarten" on pipeline_cards
  for delete using (bm_naam = my_bm_naam());

drop policy if exists "pipeline: manager wijzigt alles" on pipeline_cards;
create policy "pipeline: manager wijzigt alles" on pipeline_cards
  for update using (is_manager());

drop policy if exists "pipeline: manager verwijdert alles" on pipeline_cards;
create policy "pipeline: manager verwijdert alles" on pipeline_cards
  for delete using (is_manager());

-- 4. PROJECTENLIJST (geïmporteerd uit Excel "Projectenlijst.xlsx") -----------
-- Eén rij per lopend/afgesloten project (OVK). einde_ovk = NULL betekent een
-- nog onbepaald/oneindig project (telt mee als actief totdat er wél een
-- einddatum bekend is).
create table if not exists projecten (
  id             bigint generated always as identity primary key,
  projectnr      int  not null unique,
  kandidaat      text not null,
  bm             text,                  -- BM-initialen zoals in het Excel-bestand
  opdrachtgever  text,
  begin_ovk      date,
  einde_ovk      date,                  -- informatief; verstreken einddatum stopt de projectenlijn-telling NIET meer
  verwijderd_op  date,                  -- NULL = actief; anders: datum waarop het project uit de lijst is gehaald
                                         -- (historische weken vóór deze datum blijven meetellen in de projectenlijn)
  updated_by     uuid references auth.users(id),
  updated_at     timestamptz default now()
);

-- Bestond de tabel al van vóór deze update? Dan toch de nieuwe kolom toevoegen.
alter table projecten add column if not exists verwijderd_op date;

alter table projecten enable row level security;

drop policy if exists "projecten: manager alles" on projecten;
create policy "projecten: manager alles" on projecten
  for all using (is_manager()) with check (is_manager());

-- 5. STARTERS GOEDKEURING + PROJECTDATA op pipeline_cards ---------------------
-- Een kandidaat in de fase 'Starter' moet door de manager worden
-- beoordeeld (akkoord/niet akkoord). Bij akkoord komen begin- en vermoedelijke
-- einddatum erbij, die meelopen in de projectenlijn-grafiek. verwijderd_op
-- markeert wanneer een project/starter uit de lijst is gehaald (zie punt 4).
alter table pipeline_cards add column if not exists goedkeuring text default 'open'
  check (goedkeuring in ('open','akkoord','niet_akkoord'));
alter table pipeline_cards add column if not exists start_datum date;
alter table pipeline_cards add column if not exists eind_datum_verwacht date;
alter table pipeline_cards add column if not exists verwijderd_op date;

-- 5b. PIPELINE UITBREIDING — Starter (was 'Contractvoorstel') + nieuwe fase
-- 'Contractvoorstel' (kandidaat + opdrachtgever + salaris) + Bezoeken-reden ----
-- De fase 'Contractvoorstel' heette voorheen de manager-goedkeuringsfase; die
-- heet nu 'Starter'. Er komt een NIEUWE fase 'Contractvoorstel' met een andere
-- betekenis (kandidaat, opdrachtgever, salaris) die NIET meetelt voor de manager.
-- Eenmalige migratie (alleen bij de eerste keer uitvoeren, te herkennen aan het
-- nog ontbreken van de kolom 'opdrachtgever'): bestaande kaarten met de oude
-- betekenis van 'Contractvoorstel' worden hernoemd naar 'Starter', zodat ze in
-- de goedkeuringslijst van de manager blijven staan.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_name = 'pipeline_cards' and column_name = 'opdrachtgever'
  ) then
    update pipeline_cards set stage = 'Starter' where stage = 'Contractvoorstel';
  end if;
end $$;

alter table pipeline_cards add column if not exists opdrachtgever text;  -- Bezoeken / Contractvoorstel / Starter
alter table pipeline_cards add column if not exists salaris       text;  -- alleen Contractvoorstel
alter table pipeline_cards add column if not exists gedeeld       boolean default false; -- gedeeld met collega = telt als 0,5
alter table pipeline_cards add column if not exists bezoek_reden  text;  -- alleen Bezoeken

-- 5c. BEZOEKEN — contactpersoon + functie VERPLICHT voor alle medewerkers --------
-- Wie was het gesprek met (naam + functie van de contactpersoon bij de
-- opdrachtgever), zodat altijd duidelijk is wie er namens de klant betrokken was.
alter table pipeline_cards add column if not exists bezoek_contactpersoon text;  -- alleen Bezoeken
alter table pipeline_cards add column if not exists bezoek_contactpersoon_functie text;  -- alleen Bezoeken

-- 6. PLAN VAN AANPAK (per BM, per week — wekelijkse terugblik + planning) ----
-- Eén rij per (bm_naam, jaar, week). doel_vorige_week wordt in de webapp
-- automatisch voorgevuld met nieuw_weekdoel van de week ervoor, zodat een
-- afspraak nooit verloren gaat maar altijd doorschuift naar de volgende week.
create table if not exists plan_van_aanpak (
  id                bigint generated always as identity primary key,
  bm_naam           text not null,
  jaar              int  not null,
  week              int  not null,
  doel_vorige_week  text,
  behaald           text check (behaald in ('ja','nee')),
  verklaring        text,
  nieuw_weekdoel    text,
  acties            text,
  vacature_focus    text,
  obstakel          text,
  focuspunt         text,
  team_support      text,
  updated_by        uuid references auth.users(id),
  updated_at        timestamptz default now(),
  unique (bm_naam, jaar, week)
);

-- Notitieveld van de manager bij het plan van aanpak. Zichtbaar voor iedereen
-- (medewerker + manager), maar alleen de manager mag het bewerken (zie
-- renderPlanVanAanpak/savePlanVanAanpak in kpi_dashboard.html).
alter table plan_van_aanpak add column if not exists manager_notitie text;

alter table plan_van_aanpak enable row level security;

drop policy if exists "plan: manager ziet alles" on plan_van_aanpak;
create policy "plan: manager ziet alles" on plan_van_aanpak
  for select using (is_manager());

drop policy if exists "plan: bm ziet eigen plan" on plan_van_aanpak;
create policy "plan: bm ziet eigen plan" on plan_van_aanpak
  for select using (bm_naam = my_bm_naam());

drop policy if exists "plan: bm voert eigen plan in" on plan_van_aanpak;
create policy "plan: bm voert eigen plan in" on plan_van_aanpak
  for insert with check (bm_naam = my_bm_naam());

drop policy if exists "plan: manager voert in" on plan_van_aanpak;
create policy "plan: manager voert in" on plan_van_aanpak
  for insert with check (is_manager());

drop policy if exists "plan: bm wijzigt eigen plan" on plan_van_aanpak;
create policy "plan: bm wijzigt eigen plan" on plan_van_aanpak
  for update using (bm_naam = my_bm_naam());

drop policy if exists "plan: manager wijzigt alles" on plan_van_aanpak;
create policy "plan: manager wijzigt alles" on plan_van_aanpak
  for update using (is_manager());

-- 7. REALTIME AANZETTEN (zodat manager-scherm live meeupdate) ----------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'kpi_weekly') then
    alter publication supabase_realtime add table kpi_weekly;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'pipeline_cards') then
    alter publication supabase_realtime add table pipeline_cards;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'projecten') then
    alter publication supabase_realtime add table projecten;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'plan_van_aanpak') then
    alter publication supabase_realtime add table plan_van_aanpak;
  end if;
end $$;

-- 9. ACCOUNTMANAGEMENT — klantscoretabel ---------------------------------------
-- Per klant: strategisch/operationeel contactpersoon (initialen) en 9 scores
-- (1-5) die samen de totaalscore/ranking bepalen. Gedeelde tabel — niet per
-- BM gescheiden, iedereen die inlogt mag naam/scores invullen en wijzigen.
create table if not exists accounts (
  id                 bigint generated always as identity primary key,
  naam               text not null,
  strat_cp           text,                 -- initialen strategisch contactpersoon
  op_cp              text,                 -- initialen operationeel contactpersoon
  groeimarkt         smallint,             -- 1-5
  ambitie            smallint,             -- 1-5
  voorwaarden        smallint,             -- 1-5
  aantrekkelijkheid  smallint,             -- 1-5
  kernprofiel        smallint,             -- 1-5
  aantal_vacatures   smallint,             -- 1-5
  invloed            smallint,             -- 1-5
  relatieniveau      smallint,             -- 1-5
  procedure_score    smallint,             -- 1-5 ('Procedure' in het Excel-bestand)
  voorwaarden_bekend text,                 -- 'ja' / 'nee' / leeg
  actief_aanbieden   text,                 -- 'ja' / 'nee' / leeg
  notitie            text,
  updated_by         uuid references auth.users(id),
  updated_at         timestamptz default now()
);

alter table accounts enable row level security;

drop policy if exists "accounts: iedereen leest" on accounts;
create policy "accounts: iedereen leest" on accounts
  for select using (auth.uid() is not null);

drop policy if exists "accounts: iedereen voegt toe" on accounts;
create policy "accounts: iedereen voegt toe" on accounts
  for insert with check (auth.uid() is not null);

drop policy if exists "accounts: iedereen wijzigt" on accounts;
create policy "accounts: iedereen wijzigt" on accounts
  for update using (auth.uid() is not null);

drop policy if exists "accounts: iedereen verwijdert" on accounts;
create policy "accounts: iedereen verwijdert" on accounts
  for delete using (auth.uid() is not null);

-- Eenmalige seed met de klantenlijst uit "werkbestand 2026.xlsx" (alleen als de
-- tabel nog leeg is, zodat dit veilig is om herhaald te draaien zonder
-- dubbele rijen of overschreven wijzigingen).
do $$
begin
  if not exists (select 1 from accounts limit 1) then
    insert into accounts (naam, strat_cp, op_cp, groeimarkt, ambitie, voorwaarden, aantrekkelijkheid, kernprofiel, aantal_vacatures, invloed, relatieniveau, procedure_score, voorwaarden_bekend, actief_aanbieden, notitie) values
    ('Neways', NULL, 'CG', 5, 5, 4, 4, 5, 5, 4, 4, 3, NULL, NULL, NULL),
    ('Mourik', NULL, 'JVS', 4, 4, 4, 4, 5, 5, 3, 3, 3, NULL, NULL, NULL),
    ('Brightlands', NULL, 'LK', 5, 5, 4, 4, 4, 4, 3, 3, 3, NULL, NULL, NULL),
    ('Hoppenbrouwers', NULL, 'MW', 5, 4, 4, 4, 4, 4, 3, 4, 3, NULL, NULL, NULL),
    ('Trespa', NULL, NULL, 4, 5, 4, 4, 4, 4, 3, 3, 3, NULL, NULL, NULL),
    ('Sitech', NULL, 'JVS', 3, 4, 5, 4, 5, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Hees Installaties', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, 'ja', 'MW afspraak plannen'),
    ('Breman', NULL, 'MW', 4, 4, 4, 4, 4, 4, 3, 3, 3, NULL, NULL, NULL),
    ('IHI Hauzer', NULL, 'CG', 3, 4, 4, 4, 5, 3, 3, 3, 4, NULL, NULL, NULL),
    ('SIF', NULL, 'LK', 4, 4, 4, 4, 5, 4, 2, 2, 3, NULL, NULL, NULL),
    ('Unica', 'YB', 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, 'ja', 'MW heeft afspraak gepland, YB hierin betrokken'),
    ('Stelrad', NULL, 'JVS', 3, 3, 4, 4, 4, 2, 4, 5, 3, NULL, NULL, NULL),
    ('Avient', NULL, 'JVS', 5, 5, 3, 4, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Klimatro', NULL, 'MW', 3, 4, 4, 3, 4, 4, 3, 4, 3, NULL, NULL, NULL),
    ('Rockwool', NULL, 'JVS', 5, 4, 5, 3, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Hanab', NULL, 'MW', 4, 4, 4, 4, 4, 2, 3, 3, 3, NULL, NULL, NULL),
    ('Vandersanden', NULL, 'CG', 3, 3, 4, 4, 4, 3, 4, 3, 3, NULL, NULL, NULL),
    ('Vekoma', NULL, 'LK', 4, 5, 4, 4, 5, 4, 1, 1, 3, NULL, NULL, NULL),
    ('Kobelco', NULL, 'LK', 4, 4, 4, 4, 5, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Simac', NULL, 'MW', 3, 3, 4, 4, 5, 2, 3, 4, 3, NULL, NULL, NULL),
    ('JPE', NULL, 'MW', 4, 4, 4, 4, 5, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Manders Automation', NULL, NULL, 4, 4, 4, 4, 5, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Mondi Heerlen', NULL, 'JVS', 3, 3, 5, 4, 3, 3, 3, 4, 3, NULL, NULL, NULL),
    ('VDL Konings', NULL, 'MW', 4, 4, 4, 4, 5, 2, 2, 3, 3, NULL, NULL, NULL),
    ('Nedlin', 'YB', 'JvS', 3, 4, 3, 3, 4, 3, 3, 5, 3, 'ja', 'ja', 'YB bij Anja, JvS stelt voor'),
    ('Everzinc', NULL, 'JVS', 3, 3, 5, 3, 4, 3, 3, 4, 3, NULL, NULL, NULL),
    ('USG', NULL, 'JVS', 3, 3, 5, 4, 4, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Convoi EA', NULL, 'MW', 3, 4, 4, 4, 4, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Bilfinger', NULL, 'MW', 3, 4, 3, 4, 4, 2, 3, 4, 3, NULL, NULL, NULL),
    ('Equans', NULL, 'JVS', 3, 4, 3, 3, 5, 5, 2, 2, 3, NULL, NULL, NULL),
    ('Fudura', NULL, 'JVS', 4, 4, 4, 4, 4, 2, 2, 3, 3, NULL, NULL, NULL),
    ('Envalior', NULL, 'LK', 4, 4, 4, 4, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Lycra Company', NULL, 'LK', 4, 4, 4, 4, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Stamicarbon', NULL, 'YB', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, 'nee', 'Afspraak plannen'),
    ('WML', NULL, 'YB', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, 'ja', 'CG in lead'),
    ('Innovatest', NULL, 'LK', 3, 4, 4, 4, 5, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Braden', 'YB', 'MW', 4, 4, 3, 3, 4, 4, 3, 4, 3, 'ja', 'ja', 'Actief voorstellen'),
    ('Fenzi', 'YB', 'YB', 3, 3, 4, 3, 4, 3, 4, 4, 3, 'ja', 'ja', 'Actief voorstellen'),
    ('Koti', NULL, 'CG', 3, 3, 3, 4, 4, 4, 3, 3, 3, NULL, NULL, NULL),
    ('Vogten Staal', NULL, 'JVS', 3, 3, 4, 3, 4, 3, 3, 4, 3, NULL, NULL, NULL),
    ('Partner in Petfood', NULL, 'JVS', 4, 3, 4, 3, 4, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Viro', NULL, 'MW', 3, 4, 3, 4, 4, 2, 3, 3, 3, NULL, NULL, NULL),
    ('Spie (machinebouw)', NULL, 'CG', 4, 4, 3, 3, 4, 4, 3, 1, 3, NULL, NULL, NULL),
    ('Tata Steel SS', NULL, 'JVS', 3, 3, 4, 4, 4, 2, 3, 3, 3, NULL, NULL, NULL),
    ('Sabic', NULL, 'JVS', 4, 4, 3, 4, 4, 5, 1, 1, 3, NULL, NULL, NULL),
    ('Deerns', NULL, 'JVS', 4, 4, 3, 4, 3, 2, 3, 3, 3, NULL, NULL, NULL),
    ('CarUX', NULL, 'MW', 3, 3, 4, 4, 4, 3, 2, 3, 3, NULL, NULL, NULL),
    ('QR Metals', NULL, 'JVS', 3, 3, 4, 3, 4, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Icecool', NULL, 'MW', 3, 3, 4, 3, 4, 2, 3, 4, 3, NULL, NULL, NULL),
    ('Sappi', NULL, 'JVS', 3, 3, 3, 4, 4, 2, 3, 3, 3, NULL, NULL, NULL),
    ('Thomas Regout', NULL, NULL, 3, 3, 3, 3, 4, 3, 3, 3, 3, NULL, NULL, NULL),
    ('BRB', NULL, 'JVS', 4, 3, 3, 4, 3, 2, 3, 3, 3, NULL, NULL, NULL),
    ('NTS Mechatronics', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('VDL ETG', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Aviko', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Bakkerij Goedhart', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Canon', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Spie', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Spie MS', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Croonwolter & dros', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Frencken', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('GEA', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Homij', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Inther', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('RWE', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Syntegon', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Worley', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('ICL', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Valmont', NULL, 'CG', 2, 3, 4, 3, 4, 2, 3, 3, 3, NULL, NULL, NULL),
    ('AGCO', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Heijmans', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Nedinsco', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Nouryon', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Pentair Haffmans', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Smit Transformatoren', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Weir Minerals', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Geelen Counterflow', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Hotraco', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Koma', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Safan Darley', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Smurfit Kappa Westrock', NULL, 'JVS', 3, 3, 4, 4, 3, 2, 2, 3, 3, NULL, NULL, NULL),
    ('Sormac', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Stienen', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Van Aarsen', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('VDL Parree', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Vostermans', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Wepa', NULL, 'JVS', 2, 3, 4, 4, 3, 1, 3, 4, 3, NULL, NULL, NULL),
    ('Wipak', NULL, 'JvS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Belden', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Bodycote', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Celanese', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Eriks', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Mifa Aluminium', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Mosa', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Nedri', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Nedri Spanmetaal', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('PQ Europe', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Sibelco', NULL, 'JVS', 3, 3, 3, 3, 4, 2, 3, 3, 3, NULL, NULL, NULL),
    ('Solvay', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('The Jekill and Hyde Company', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('VDL Staalservice', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('WP Haton', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Basic Pharma', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Dohler', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Limagrain', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Ranpak', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Vistaprint', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Goss Contiweb', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Nyrstar', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Smile Plastics', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Refresco (MH)', NULL, 'TJ', 4, 4, 4, 4, 3, 3, 1, 1, 3, NULL, NULL, NULL),
    ('Refresco (SI / Br)', NULL, 'TJ', 4, 4, 4, 4, 3, 3, 1, 1, 3, NULL, NULL, NULL),
    ('Dalli de Klok', 'YB', 'YB', 3, 3, 3, 3, 3, 3, 3, 3, 4, 'ja', 'ja', 'SOVK wordt getekend'),
    ('Asco', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Euramax', NULL, 'LK', 3, 4, 3, 3, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Royal Kusters', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Wienerberger', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Wienerberger (Thorn & Brunssum)', NULL, NULL, 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Budé', 'YB', 'YB', 3, 3, 3, 3, 4, 4, 3, 3, 3, NULL, 'nee', 'YB in lead, 2de afspraak om voorstel te bespreken'),
    ('Transpo Nuth', NULL, 'LK', 3, 3, 3, 3, 3, 2, 3, 4, 3, NULL, NULL, NULL),
    ('Christiaens', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('De Boer Machines', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('ETF', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Frerotech', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Groba', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('GTE', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('HKB Ketelbouw', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Kom EA', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Laarman Group', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Laura Metaal', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Limex', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Lucassen', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Machinefabriek Bex', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Mainsupport', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Mayfran', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Meex', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Montair Prcesss Technology', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('PDM', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Poeth', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Rimas', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Steinbusch', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Van der zalm', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Van Doren Engineers', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Bomacon', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('AAE', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Dutch Wheels', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Fuij Seal', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Aton', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Balemaster', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Burrows', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('CPS', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Dinissen', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Greymans', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('GTL', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Madolex', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('MGG', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Microz', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('NovoFerm', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Roosen BPL', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Rubber Resources', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('S-Alveo', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Schmitzfoam', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('S-Eslon', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('S-Lec', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Smink Group', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Sofine', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Toppoint', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('VH Packacking', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Vibrantz', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Xella', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Bakkersland Panningen', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Bakkersland Sevenum', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Biscuit International', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Group of Butchers', NULL, 'JVS', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Mora', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Soma Bakery', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Koma ', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('VDK ', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('JPE ', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('Janssen Bartels', NULL, 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, NULL, NULL),
    ('APT Extrusions', NULL, NULL, 3, 3, 3, 3, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Briggs & Stratton', NULL, 'LK', 3, 3, 3, 3, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Cox Geelen', 'LK', 'YB', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, 'nee', 'LK in lead, afspraak met Paul Bruynen'),
    ('Cro-Tech', 'YB', 'YB', 3, 3, 3, 3, 4, 3, 3, 4, 4, 'ja', 'ja', NULL),
    ('EKK Eagle Simrax', NULL, 'LK', 3, 3, 3, 3, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Frijns', NULL, 'LK', 3, 3, 3, 3, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Haan (L&P)', 'YB', 'YB', 3, 3, 3, 3, 4, 3, 2, 2, 3, 'ja', 'ja', NULL),
    ('Keytech', NULL, NULL, 3, 3, 3, 3, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Machinefabriek Klinkers', NULL, 'LK', 3, 3, 3, 3, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('NES', 'LK', 'MW', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, 'ja', 'Installatietechniek dus afspraak plannen'),
    ('Quantum Controls / Wetech', NULL, 'YB', 3, 3, 3, 3, 4, 3, 2, 2, 3, NULL, 'ja', 'Afspraak plannen met Marcel Thewessen'),
    ('SBE', NULL, NULL, 3, 3, 3, 3, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('Zandstra', NULL, NULL, 3, 3, 3, 3, 4, 3, 2, 2, 3, NULL, NULL, NULL),
    ('E-max', NULL, 'JVS', 3, 3, 3, 3, 3, 2, 3, 3, 3, NULL, NULL, NULL),
    ('Pregis', NULL, 'JVS', 3, 3, 3, 3, 3, 2, 3, 3, 3, NULL, NULL, NULL),
    ('DS Metaal', NULL, 'MW', 3, 3, 3, 3, 3, 2, 2, 3, 3, NULL, NULL, NULL),
    ('Lawter', NULL, 'JVS', 2, 3, 3, 3, 3, 2, 3, 3, 3, NULL, NULL, NULL),
    ('Carbolim', NULL, 'LK', 3, 3, 3, 3, 3, 2, 2, 2, 3, NULL, NULL, NULL),
    ('Frissen', NULL, 'YB', 3, 3, 3, 3, 3, 1, 2, 2, 3, NULL, 'ja', 'Kleine organisatie, nu niet op zoek'),
    ('Geelen Beton', NULL, 'LK', 3, 3, 3, 3, 3, 2, 2, 2, 3, NULL, NULL, NULL),
    ('Kupron', NULL, 'LK', 3, 3, 3, 3, 3, 2, 2, 2, 3, NULL, NULL, NULL),
    ('LUC Group', NULL, 'LK', 3, 3, 3, 3, 3, 2, 2, 2, 3, NULL, NULL, NULL),
    ('Nora', NULL, 'LK', 3, 3, 3, 3, 3, 2, 2, 2, 3, NULL, NULL, NULL),
    ('Oostwegel', NULL, NULL, 3, 3, 3, 3, 3, 2, 2, 2, 3, NULL, NULL, NULL),
    ('Stogger', NULL, 'CG', 3, 3, 3, 3, 3, 3, 1, 1, 3, NULL, 'nee', 'Hebben geen hulp van externe, eigen recruitment werkt goed'),
    ('Ubroek', NULL, 'CG', 3, 3, 3, 3, 3, 3, 3, 3, 3, NULL, 'nee', NULL),
    ('VSA', NULL, 'MW', 3, 3, 3, 3, 3, 2, 2, 2, 3, NULL, NULL, NULL),
    ('WBL', 'CG', 'CG', 3, 3, 3, 3, 3, 4, 2, 3, 3, NULL, 'ja', NULL),
    ('Unisign', NULL, 'CG', 3, 3, 1, 3, 4, 4, 1, 1, 3, NULL, NULL, NULL),
    ('Daily Fresh', NULL, 'YB', 3, 3, 3, 3, 2, 2, 2, 2, 3, NULL, 'nee', 'Wil enkel samenwerken op basis van W&S'),
    ('Tata Steel Tubes', NULL, 'JVS', 3, 3, 3, 3, 4, 1, 1, 1, 3, NULL, NULL, NULL);
  end if;
end $$;

-- Realtime ook voor accounts (zodat updates van collega's live doorkomen)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'accounts') then
    alter publication supabase_realtime add table accounts;
  end if;
end $$;

-- 8. INLOG Luc Kools (Key Accountmanager) ------------------------------------
-- Auth-gebruiker is al aangemaakt in Supabase (Authentication > Users); dit
-- koppelt dat account aan een profiel zodat hij kan inloggen op het dashboard.
-- "on conflict (id) do update" maakt dit veilig om opnieuw te draaien.
insert into profiles (id, naam, rol, bm_naam, doel, kleur)
values ('e0578143-fc28-4527-a2e6-4f71c159812d', 'Luc Kools', 'bm', 'Luc Kools', 8, '#0891b2')
on conflict (id) do update set
  naam    = excluded.naam,
  rol     = excluded.rol,
  bm_naam = excluded.bm_naam,
  doel    = excluded.doel,
  kleur   = excluded.kleur;

-- 9. Moneybird-koppeling: omzet per opdrachtgever -----------------------------
-- Optioneel koppelveld op accounts: als de klantnaam in Moneybird niet exact
-- overeenkomt met de naam in 'accounts' (bv. afkorting of andere schrijfwijze),
-- vul dan hier het Moneybird contact-id in zodat de sync die klant alsnog kan
-- matchen. Leeg laten is prima — dan wordt er eerst op naam gematcht.
alter table accounts add column if not exists moneybird_contact_id text;

-- Omzet per opdrachtgever, bijgewerkt door de Supabase Edge Function
-- 'moneybird-sync' (zie /supabase/functions/moneybird-sync). Het Moneybird
-- API-token zelf staat nooit in deze database of in de browser — alleen het
-- resultaat (bedragen) komt hier terecht.
create table if not exists financieel_omzet (
  opdrachtgever              text primary key,    -- moet overeenkomen met accounts.naam
  moneybird_contact_id       text,
  omzet_ytd                  numeric default 0,   -- gefactureerd dit kalenderjaar (excl. btw)
  omzet_vorig_jaar            numeric default 0,   -- gefactureerd het vorige kalenderjaar (excl. btw)
  omzet_totaal               numeric default 0,   -- gefactureerd all-time (excl. btw)
  openstaand                 numeric default 0,   -- nog niet betaalde facturen (excl. btw)
  vervallen                  numeric default 0,   -- vervaldatum verstreken en nog niet betaald
  aantal_facturen_ytd        integer default 0,
  aantal_facturen_vervallen  integer default 0,
  omzet_historie             jsonb default '{}'::jsonb, -- omzet per jaar voor alle jaren behalve het huidige, bv. {"2025":12345.67,"2024":8230}
  laatst_gesynchroniseerd    timestamptz
);

-- Bestaande installatie? Dan voegen deze regels de nieuwe kolommen toe
-- zonder bestaande data te raken (zie ook moneybird_migratie_v2.sql en _v3.sql).
alter table financieel_omzet add column if not exists omzet_vorig_jaar numeric default 0;
alter table financieel_omzet add column if not exists vervallen numeric default 0;
alter table financieel_omzet add column if not exists aantal_facturen_vervallen integer default 0;
alter table financieel_omzet add column if not exists omzet_historie jsonb default '{}'::jsonb;

alter table financieel_omzet enable row level security;

-- Iedereen die ingelogd is mag de cijfers lezen (zelfde patroon als 'accounts').
drop policy if exists "financieel_omzet: iedereen leest" on financieel_omzet;
create policy "financieel_omzet: iedereen leest" on financieel_omzet
  for select using (auth.uid() is not null);

-- Schrijven gebeurt uitsluitend door de Edge Function via de service-role key
-- (die RLS altijd omzeilt) — er is dus bewust geen insert/update/delete-policy
-- voor gewone ingelogde gebruikers, zodat niemand via de browser de omzetcijfers
-- kan vervalsen.

-- Realtime ook voor financieel_omzet (zodat een sync direct doorkomt bij iedereen)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'financieel_omzet') then
    alter publication supabase_realtime add table financieel_omzet;
  end if;
end $$;

-- 10. BEGROTING (geïmporteerd uit Excel "Begroting.xlsx") --------------------
-- Twee sheets: "Begroting omzetten" (maandelijkse begrote omzet + declarabiliteit,
-- meerdere jaren) en "Projectenstand" (wekelijks begrote projectenlijn). Beide
-- zijn uitsluitend voor de manager (zelfde patroon als 'projecten' hierboven) —
-- de Financieel- en Prognose-tabbladen zijn toch al manager-only.
create table if not exists begroting_omzet (
  jaar                     int not null,
  maand                    int not null check (maand between 1 and 12),
  omzet_begroot            numeric default 0,
  declarabiliteit_begroot  numeric,
  primary key (jaar, maand)
);
alter table begroting_omzet enable row level security;
drop policy if exists "begroting_omzet: manager alles" on begroting_omzet;
create policy "begroting_omzet: manager alles" on begroting_omzet
  for all using (is_manager()) with check (is_manager());

create table if not exists begroting_projectenlijn (
  jaar          int not null,
  week          int not null check (week between 1 and 53),
  begrote_lijn  numeric default 0,
  primary key (jaar, week)
);
alter table begroting_projectenlijn enable row level security;
drop policy if exists "begroting_projectenlijn: manager alles" on begroting_projectenlijn;
create policy "begroting_projectenlijn: manager alles" on begroting_projectenlijn
  for all using (is_manager()) with check (is_manager());

-- Werkelijke omzet per maand (alle opdrachtgevers samen), bijgewerkt door de
-- Edge Function 'moneybird-sync' — voor vergelijking met begroting_omzet.
-- Schrijven gebeurt uitsluitend door de Edge Function via de service-role key.
create table if not exists financieel_omzet_maand (
  jaar             int not null,
  maand            int not null check (maand between 1 and 12),
  omzet            numeric default 0,
  aantal_facturen  int default 0,
  primary key (jaar, maand)
);
alter table financieel_omzet_maand enable row level security;
drop policy if exists "financieel_omzet_maand: manager leest" on financieel_omzet_maand;
create policy "financieel_omzet_maand: manager leest" on financieel_omzet_maand
  for select using (is_manager());

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'financieel_omzet_maand') then
    alter publication supabase_realtime add table financieel_omzet_maand;
  end if;
end $$;

-- ============================================================================
-- Klaar. Volgende stap: gebruikers aanmaken via Supabase Dashboard
-- (Authentication > Users > Add user) en daarna per gebruiker een rij in
-- 'profiles' toevoegen (Table editor > profiles > Insert row) met hetzelfde
-- id als de aangemaakte auth-gebruiker. Zie setup_instructies.md voor de
-- volledige stap-voor-stap uitleg.
--
-- Bestaande databases: dit bestand mag je opnieuw volledig plakken en
-- uitvoeren in de SQL Editor — "create table if not exists", "add column
-- if not exists" en "drop policy if exists" zorgen dat bestaande data en
-- regels intact blijven en alleen het nieuwe (projecten-tabel +
-- goedkeuringsvelden) wordt toegevoegd. Veilig om zo vaak te herhalen als nodig.
-- ============================================================================
