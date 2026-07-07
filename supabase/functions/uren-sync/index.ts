// Supabase Edge Function: uren-sync
//
// Wat doet dit?
// Haalt het Excel-bestand "Urenrapportage" op vanaf de gedeelde SharePoint-
// link (de directe-downloadlink, geen login nodig), leest het uit en
// berekent per maand (en per maand+opdrachtgever) de declarabiliteit,
// ziekte-uren, marge en overuren. De uitkomsten worden weggeschreven naar de
// tabellen 'uren_kpi_maand' en 'uren_kpi_opdrachtgever_maand', die het
// dashboard vervolgens gewoon uitleest zoals elke andere tabel.
//
// Waarom in stappen ("fases")?
// Het bestand is na het uitpakken ±650MB platte XML met 268.000+ regels.
// Een Edge Function mag maar een beperkt aantal seconden ACTIEVE rekentijd
// gebruiken per aanroep (niet de wachttijd op het downloaden — alleen de tijd
// dat de CPU daadwerkelijk aan het rekenen is). Het hele bestand in één keer
// helemaal uitlezen duurt te lang voor die limiet. Daarom verdeelt deze
// functie het werk over meerdere achtereenvolgende aanroepen: elke aanroep
// haalt het bestand opnieuw op (downloaden + uitpakken is goedkoop) maar
// rekent alleen de cijfers uit voor 1 van de PASSES "porties" van de regels
// (regel 1 hoort bij portie 0, regel 2 bij portie 1, regel 3 bij portie 2,
// enzovoort, daarna weer terug naar 0 — zo blijft elke portie ongeveer
// even groot zonder dat we van tevoren het totaal aantal regels moeten
// weten). Na de laatste portie worden de tussenresultaten omgezet naar de
// definitieve KPI-tabellen.
//
// Wordt elke nacht automatisch een paar keer achter elkaar aangeroepen door
// pg_cron (zie urenrapportage_cron.sql) totdat de sync voor die dag klaar is.
// Kan ook handmatig gestart worden via de "Vernieuwen nu"-knop op het
// dashboard (alleen door een manager).
//
// Vereiste secret (instellen via Supabase Dashboard > Edge Functions > Secrets):
//   URENRAPPORTAGE_URL — de directe-downloadlink naar Urenrapportage.xlsx
//                         (de SharePoint-link met &download=1 erachter, met
//                         deelinstelling "Iedereen met de koppeling kan
//                         bekijken")
// (SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY staan automatisch al klaar.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Unzip, UnzipInflate } from "https://esm.sh/fflate@0.8.3";

// Aantal "porties" waarover een volledige sync verdeeld wordt. Hoger = elke
// aanroep rekent minder en is dus veiliger binnen de tijdslimiet, maar de
// volledige sync duurt dan wel meer aanroepen (geen probleem 's nachts, er is
// uren de tijd). Verhoog dit gerust als het bestand in de toekomst nog veel
// groter wordt en je een keer "tijdslimiet overschreden"-achtige fouten ziet.
const PASSES = 6;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ── Eén streaming download+uitpak+leespass over het bestand ────────────────
// Leest zowel xl/sharedStrings.xml (klein, volledig gebufferd) als
// xl/worksheets/sheet1.xml (groot, alleen rij-grenzen herkennen + voor de
// regels die bij deze 'passIndex' horen de benodigde kolommen ruw opslaan).
// Celwaarden die naar een tekst-tabel verwijzen (t="s") worden pas ná de hele
// stream omgezet naar echte tekst, omdat sheet1.xml in dit bestand vóór
// sharedStrings.xml staat — de tekst-tabel is dus nog niet compleet terwijl
// sheet1.xml binnenkomt.
async function streamPass(url: string, passIndex: number): Promise<{
  rows: RawRow[];
  shared: string[];
  regelsGezien: number;
}> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Bestand ophalen mislukt (HTTP ${res.status})`);
  }

  const shared: string[] = [];
  let sstChunks: Uint8Array[] = [];
  const rows: RawRow[] = [];
  let regelsGezien = 0;

  // Rollende tekstbuffer voor sheet1.xml — we houden nooit meer dan een paar
  // megabyte tekst tegelijk in het geheugen; verwerkte stukken gooien we
  // direct weg.
  let rolling = "";
  const decoder = new TextDecoder("utf-8");
  const rowRe = /<row r="\d+"[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c r="([A-Z]+)\d+"(?:\s+t="(\w+)")?[^>]*>(?:<v>([\s\S]*?)<\/v>)?<\/c>/g;
  const WANTED = new Set(["A", "B", "D", "H", "I", "J", "K", "L", "W"]);

  function consumeSheetText(text: string, isFinal: boolean) {
    rolling += text;
    const lastRowEnd = rolling.lastIndexOf("</row>");
    if (lastRowEnd === -1 && !isFinal) return; // nog geen complete rij binnen
    const processable = isFinal ? rolling : rolling.slice(0, lastRowEnd + 6);
    rolling = isFinal ? "" : rolling.slice(lastRowEnd + 6);

    rowRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(processable)) !== null) {
      regelsGezien++;
      if (regelsGezien === 1) continue; // headerrij overslaan
      if ((regelsGezien - 2) % PASSES !== passIndex) continue; // hoort niet bij deze portie

      const rowBody = m[1];
      const raw: RawRow = {};
      cellRe.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = cellRe.exec(rowBody)) !== null) {
        const col = cm[1];
        if (!WANTED.has(col)) continue;
        const isShared = cm[2] === "s";
        const val = cm[3];
        raw[col] = { v: val, s: isShared };
      }
      rows.push(raw);
    }
  }

  const unzipper = new Unzip();
  unzipper.register(UnzipInflate);
  unzipper.onfile = (file) => {
    if (file.name === "xl/worksheets/sheet1.xml") {
      file.ondata = (err, dat, final) => {
        if (err) throw err;
        const text = decoder.decode(dat, { stream: !final });
        consumeSheetText(text, !!final);
      };
      file.start();
    } else if (file.name === "xl/sharedStrings.xml") {
      file.ondata = (err, dat) => {
        if (err) throw err;
        sstChunks.push(dat);
      };
      file.start();
    }
  };

  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      unzipper.push(new Uint8Array(0), true);
      break;
    }
    unzipper.push(value, false);
  }

  // sharedStrings.xml verwerken (klein, in één keer)
  if (sstChunks.length) {
    const totalLen = sstChunks.reduce((a, c) => a + c.length, 0);
    const merged = new Uint8Array(totalLen);
    let off = 0;
    for (const c of sstChunks) { merged.set(c, off); off += c.length; }
    const sstXml = new TextDecoder("utf-8").decode(merged);
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(sstXml)) !== null) {
      const block = m[1];
      let text = "";
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let tm: RegExpExecArray | null;
      while ((tm = tRe.exec(block)) !== null) text += tm[1];
      shared.push(decodeXmlEntities(text));
    }
  }

  return { rows, shared, regelsGezien };
}

type RawCell = { v?: string; s: boolean };
type RawRow = Record<string, RawCell>;

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function resolve(cell: RawCell | undefined, shared: string[]): string {
  if (!cell || cell.v === undefined) return "";
  if (cell.s) {
    const idx = parseInt(cell.v, 10);
    return shared[idx] ?? "";
  }
  return decodeXmlEntities(cell.v);
}

// Excel-datumserienummer (vanaf 30-12-1899) naar {jaar, maand}
function excelSerialToYearMonth(serial: number): { jaar: number; maand: number } | null {
  if (!isFinite(serial) || serial <= 0) return null;
  const ms = (serial - 25569) * 86400 * 1000; // 25569 = dagen tussen 30-12-1899 en 1-1-1970
  const d = new Date(ms);
  return { jaar: d.getUTCFullYear(), maand: d.getUTCMonth() + 1 };
}

type MaandAgg = {
  declarabel: number; ziekte: number; verlof: number; bijzonderVerlof: number; overigAanvullend: number;
  omzet: number; loon: number; overurenUren: number; overurenLoon: number;
};
type Aggregaten = {
  maand: Record<string, MaandAgg>;
  opdrachtgever: Record<string, { declarabel: number; aanvullend: number; omzet: number; loon: number }>;
};

function leegMaandAgg(): MaandAgg {
  return { declarabel: 0, ziekte: 0, verlof: 0, bijzonderVerlof: 0, overigAanvullend: 0, omzet: 0, loon: 0, overurenUren: 0, overurenLoon: 0 };
}

// Verwerkt de ruwe regels van 1 portie tot tussenresultaten en telt ze bij de
// (over de vorige porties al opgebouwde) totalen op.
function verwerkPortie(rows: RawRow[], shared: string[], acc: Aggregaten): number {
  let verwerkt = 0;
  for (const raw of rows) {
    const A = resolve(raw["A"], shared); // datum (serienummer)
    const D = parseFloat(resolve(raw["D"], shared)) || 0; // aantal uren
    const H = resolve(raw["H"], shared); // status
    const I = parseFloat(resolve(raw["I"], shared)) || 0; // tarief
    const J = parseFloat(resolve(raw["J"], shared)) || 0; // loon (kostprijs)
    const K = resolve(raw["K"], shared); // urensoort
    const L = resolve(raw["L"], shared); // componenttype
    const W = resolve(raw["W"], shared); // opdrachtgever (inlener)

    if (H === "Nieuw") continue; // nog niet definitief, niet meetellen
    const ym = excelSerialToYearMonth(parseFloat(A));
    if (!ym) continue;
    verwerkt++;

    const key = `${ym.jaar}-${ym.maand}`;
    if (!acc.maand[key]) acc.maand[key] = leegMaandAgg();
    const m = acc.maand[key];

    const prefix = K.includes(" · ") ? K.split(" · ")[0] : K;
    const isOveruren = /overuren|overwerk/i.test(prefix);

    if (L === "Urensoort") {
      m.declarabel += D;
      m.omzet += D * I;
      m.loon += D * J;
    } else if (L === "Aanvullend urensoort") {
      m.loon += D * J;
      if (prefix.startsWith("Ziekte")) m.ziekte += D;
      else if (prefix.startsWith("Verlof")) m.verlof += D;
      else if (prefix.startsWith("Ouderschaps verlof")) m.bijzonderVerlof += D;
      else m.overigAanvullend += D;
    }
    // Componenttype 'Vergoeding' telt niet mee in declarabiliteit/marge.

    if (isOveruren) {
      m.overurenUren += D;
      m.overurenLoon += D * J;
    }

    if (W && (L === "Urensoort" || L === "Aanvullend urensoort")) {
      const okey = `${ym.jaar}-${ym.maand}|${W}`;
      if (!acc.opdrachtgever[okey]) acc.opdrachtgever[okey] = { declarabel: 0, aanvullend: 0, omzet: 0, loon: 0 };
      const o = acc.opdrachtgever[okey];
      if (L === "Urensoort") { o.declarabel += D; o.omzet += D * I; o.loon += D * J; }
      else { o.aanvullend += D; o.loon += D * J; }
    }
  }
  return verwerkt;
}

async function schrijfDefinitieveKpis(admin: ReturnType<typeof createClient>, acc: Aggregaten) {
  const maandRows = Object.entries(acc.maand).map(([key, m]) => {
    const [jaarStr, maandStr] = key.split("-");
    const totaal100 = m.declarabel + m.ziekte + m.verlof + m.bijzonderVerlof + m.overigAanvullend;
    const decPct = totaal100 > 0 ? (m.declarabel / totaal100) * 100 : 0;
    const ziektePct = totaal100 > 0 ? (m.ziekte / totaal100) * 100 : 0;
    const margePct = m.omzet > 0 ? ((m.omzet - m.loon) / m.omzet) * 100 : 0;
    return {
      jaar: parseInt(jaarStr, 10),
      maand: parseInt(maandStr, 10),
      declarabele_uren: round2(m.declarabel),
      ziekte_uren: round2(m.ziekte),
      verlof_uren: round2(m.verlof),
      bijzonder_verlof_uren: round2(m.bijzonderVerlof),
      overig_aanvullend_uren: round2(m.overigAanvullend),
      totaal_100pct_uren: round2(totaal100),
      declarabiliteit_pct: round2(decPct),
      ziekte_pct: round2(ziektePct),
      omzet_uren: round2(m.omzet),
      loonkosten: round2(m.loon),
      marge_pct: round2(margePct),
      overuren_uren: round2(m.overurenUren),
      overuren_loonkosten: round2(m.overurenLoon),
      bijgewerkt_op: new Date().toISOString(),
    };
  });
  if (maandRows.length) {
    const { error } = await admin.from("uren_kpi_maand").upsert(maandRows, { onConflict: "jaar,maand" });
    if (error) throw new Error(`Wegschrijven uren_kpi_maand mislukt: ${error.message}`);
  }

  const opdrRows = Object.entries(acc.opdrachtgever).map(([key, o]) => {
    const [ymKey, opdrachtgever] = key.split("|");
    const [jaarStr, maandStr] = ymKey.split("-");
    const totaal = o.declarabel + o.aanvullend;
    const decPct = totaal > 0 ? (o.declarabel / totaal) * 100 : 0;
    const margePct = o.omzet > 0 ? ((o.omzet - o.loon) / o.omzet) * 100 : 0;
    return {
      jaar: parseInt(jaarStr, 10),
      maand: parseInt(maandStr, 10),
      opdrachtgever,
      declarabele_uren: round2(o.declarabel),
      aanvullend_uren: round2(o.aanvullend),
      declarabiliteit_pct: round2(decPct),
      omzet_uren: round2(o.omzet),
      loonkosten: round2(o.loon),
      marge_pct: round2(margePct),
      bijgewerkt_op: new Date().toISOString(),
    };
  });
  // In porties van 500 wegschrijven om te grote requests te voorkomen.
  for (let i = 0; i < opdrRows.length; i += 500) {
    const batch = opdrRows.slice(i, i + 500);
    const { error } = await admin.from("uren_kpi_opdrachtgever_maand").upsert(batch, { onConflict: "jaar,maand,opdrachtgever" });
    if (error) throw new Error(`Wegschrijven uren_kpi_opdrachtgever_maand mislukt: ${error.message}`);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  try {
    // ── Toegang: pg_cron (service-role key) of een ingelogde manager ───────
    const authHeader = req.headers.get("Authorization") || "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "");
    const isCron = bearer === SERVICE_ROLE_KEY;
    if (!isCron) {
      const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userData, error: userErr } = await userClient.auth.getUser();
      if (userErr || !userData?.user) return json({ error: "Niet ingelogd of sessie verlopen." }, 401);
      const { data: profile } = await userClient.from("profiles").select("rol").eq("id", userData.user.id).single();
      if (!profile || profile.rol !== "manager") return json({ error: "Alleen een manager mag een Urenrapportage-sync starten." }, 403);
    }

    const URENRAPPORTAGE_URL = Deno.env.get("URENRAPPORTAGE_URL");
    if (!URENRAPPORTAGE_URL) {
      return json({ error: "URENRAPPORTAGE_URL is niet ingesteld als secret." }, 500);
    }

    const { data: statusRow } = await admin.from("uren_sync_status").select("*").eq("id", 1).single();
    const status = statusRow || { fase: "klaar", deel_huidig: 0, deel_totaal: PASSES, tussenresultaat: {}, regels_verwerkt: 0, laatst_gesynchroniseerd: null };

    const vandaag = new Date().toISOString().slice(0, 10);
    const laatsteDag = status.laatst_gesynchroniseerd ? new Date(status.laatst_gesynchroniseerd).toISOString().slice(0, 10) : null;

    if (status.fase === "klaar" && laatsteDag === vandaag) {
      return json({ ok: true, boodschap: "Vandaag al gesynchroniseerd.", status });
    }

    let deelHuidig = status.deel_huidig ?? 0;
    let acc: Aggregaten = (status.tussenresultaat && Object.keys(status.tussenresultaat).length)
      ? status.tussenresultaat as Aggregaten
      : { maand: {}, opdrachtgever: {} };
    let regelsVerwerktTotaal = status.regels_verwerkt ?? 0;

    if (status.fase !== "verwerken") {
      // Nieuwe nachtelijke run starten.
      deelHuidig = 0;
      acc = { maand: {}, opdrachtgever: {} };
      regelsVerwerktTotaal = 0;
      await admin.from("uren_sync_status").upsert({
        id: 1, fase: "verwerken", deel_huidig: 0, deel_totaal: PASSES,
        tussenresultaat: acc, regels_verwerkt: 0, laatste_fout: null,
        bijgewerkt_op: new Date().toISOString(),
      });
    }

    const { rows, shared, regelsGezien } = await streamPass(URENRAPPORTAGE_URL, deelHuidig);
    const verwerktDezeKeer = verwerkPortie(rows, shared, acc);
    regelsVerwerktTotaal += verwerktDezeKeer;

    const volgendeDeel = deelHuidig + 1;
    if (volgendeDeel >= PASSES) {
      await schrijfDefinitieveKpis(admin, acc);
      await admin.from("uren_sync_status").update({
        fase: "klaar", deel_huidig: PASSES, tussenresultaat: {},
        regels_verwerkt: regelsVerwerktTotaal,
        laatst_gesynchroniseerd: new Date().toISOString(),
        bijgewerkt_op: new Date().toISOString(),
      }).eq("id", 1);
      return json({ ok: true, klaar: true, deel: PASSES, van: PASSES, regelsVerwerkt: regelsVerwerktTotaal, regelsGezienLaatstePortie: regelsGezien });
    } else {
      await admin.from("uren_sync_status").update({
        deel_huidig: volgendeDeel, tussenresultaat: acc, regels_verwerkt: regelsVerwerktTotaal,
        bijgewerkt_op: new Date().toISOString(),
      }).eq("id", 1);
      return json({ ok: true, klaar: false, deel: volgendeDeel, van: PASSES, regelsVerwerkt: regelsVerwerktTotaal });
    }
  } catch (e) {
    try {
      await admin.from("uren_sync_status").update({
        fase: "fout", laatste_fout: String((e as Error)?.message || e),
        bijgewerkt_op: new Date().toISOString(),
      }).eq("id", 1);
    } catch { /* best effort */ }
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
