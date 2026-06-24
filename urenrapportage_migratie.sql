-- ============================================================================
-- Urenrapportage-koppeling: schema voor de nachtelijke sync vanuit het
-- SharePoint Excel-bestand (declarabiliteit, ziekte, marge, overuren).
-- Plak dit volledige bestand in: Supabase project > SQL Editor > New query > Run
-- ============================================================================

-- ── Status van de gefaseerde sync ───────────────────────────────────────────
-- Het bronbestand is ±650MB aan platte XML zodra het is uitgepakt en bevat
-- 268.000+ regels. Eén Supabase Edge Function-aanroep mag maar ~2 seconden
-- actieve rekentijd gebruiken — dat is te weinig om alles in één keer te
-- verwerken. Daarom verwerkt de Edge Function 'uren-sync' het bestand in
-- meerdere achtereenvolgende aanroepen (elke aanroep haalt het bestand opnieuw
-- op en verwerkt steeds een ander deel van de regels — dat is geen probleem,
-- downloaden/uitpakken is goedkoop, alleen het uitlezen van alle regels is
-- duur), en deze tabel houdt bij waar de sync gebleven is en wat de tot nu
-- toe opgetelde tussenresultaten zijn, zodat elke volgende aanroep (vanuit
-- pg_cron) precies verder gaat waar de vorige stopte. Er is altijd maar 1 rij
-- (id = 1).
create table if not exists uren_sync_status (
  id                       smallint primary key default 1,
  fase                     text default 'klaar',   -- 'klaar' | 'ophalen' | 'verwerken' | 'afronden' | 'fout'
  deel_huidig              integer default 0,
  deel_totaal              integer default 0,
  regels_verwerkt          integer default 0,
  tussenresultaat          jsonb default '{}'::jsonb, -- opgebouwde aggregatie tijdens het verwerken van de delen
  laatst_gesynchroniseerd  timestamptz,
  laatste_fout             text,
  bijgewerkt_op            timestamptz default now(),
  constraint uren_sync_status_single_row check (id = 1)
);

insert into uren_sync_status (id) values (1) on conflict (id) do nothing;

alter table uren_sync_status enable row level security;
drop policy if exists "uren_sync_status: iedereen leest" on uren_sync_status;
create policy "uren_sync_status: iedereen leest" on uren_sync_status
  for select using (auth.uid() is not null);
-- Schrijven gebeurt uitsluitend door de Edge Function via de service-role key.

-- ── KPI's per maand (alle opdrachtgevers samen) ─────────────────────────────
-- Gevuld door de Edge Function 'uren-sync'. Voedt de subtabs Declarabiliteit,
-- Ziekte overzicht, Marge overzicht en Overuren-overzicht op het dashboard.
create table if not exists uren_kpi_maand (
  jaar                     integer not null,
  maand                    integer not null,        -- 1 t/m 12
  declarabele_uren         numeric default 0,        -- componenttype 'Urensoort'
  ziekte_uren              numeric default 0,        -- aanvullend urensoort, urensoort begint met 'Ziekte'
  verlof_uren              numeric default 0,        -- aanvullend urensoort, urensoort begint met 'Verlof'
  bijzonder_verlof_uren    numeric default 0,        -- aanvullend urensoort, urensoort begint met 'Ouderschaps verlof'
  overig_aanvullend_uren   numeric default 0,        -- overige aanvullend-urensoorten (feestdag e.d.)
  totaal_100pct_uren       numeric default 0,        -- declarabel + alle aanvullend (excl. vergoedingen)
  declarabiliteit_pct      numeric default 0,        -- declarabele_uren / totaal_100pct_uren * 100
  ziekte_pct               numeric default 0,        -- ziekte_uren / totaal_100pct_uren * 100
  omzet_uren               numeric default 0,        -- som(aantal_uren * tarief), alleen declarabele uren
  loonkosten               numeric default 0,        -- som(aantal_uren * loon), declarabel + aanvullend
  marge_pct                numeric default 0,        -- (omzet_uren - loonkosten) / omzet_uren * 100
  overuren_uren            numeric default 0,        -- urensoort bevat 'overuren' of 'overwerk'
  overuren_loonkosten      numeric default 0,
  bijgewerkt_op            timestamptz default now(),
  primary key (jaar, maand)
);

alter table uren_kpi_maand enable row level security;
drop policy if exists "uren_kpi_maand: iedereen leest" on uren_kpi_maand;
create policy "uren_kpi_maand: iedereen leest" on uren_kpi_maand
  for select using (auth.uid() is not null);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'uren_kpi_maand') then
    alter publication supabase_realtime add table uren_kpi_maand;
  end if;
end $$;

-- ── KPI's per maand per opdrachtgever (voor de ranking) ─────────────────────
create table if not exists uren_kpi_opdrachtgever_maand (
  jaar                     integer not null,
  maand                    integer not null,
  opdrachtgever            text not null,
  declarabele_uren         numeric default 0,
  aanvullend_uren          numeric default 0,
  declarabiliteit_pct      numeric default 0,
  omzet_uren               numeric default 0,
  loonkosten               numeric default 0,
  marge_pct                numeric default 0,
  bijgewerkt_op            timestamptz default now(),
  primary key (jaar, maand, opdrachtgever)
);

alter table uren_kpi_opdrachtgever_maand enable row level security;
drop policy if exists "uren_kpi_opdrachtgever_maand: iedereen leest" on uren_kpi_opdrachtgever_maand;
create policy "uren_kpi_opdrachtgever_maand: iedereen leest" on uren_kpi_opdrachtgever_maand
  for select using (auth.uid() is not null);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'uren_kpi_opdrachtgever_maand') then
    alter publication supabase_realtime add table uren_kpi_opdrachtgever_maand;
  end if;
end $$;

