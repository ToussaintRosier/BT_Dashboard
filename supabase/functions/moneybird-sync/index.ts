// Supabase Edge Function: moneybird-sync
//
// Wat doet dit?
// Haalt facturen op uit Moneybird (via een geheim API-token dat ALLEEN hier,
// server-side, bekend is — nooit in de browser/dashboard) en telt per
// opdrachtgever op hoeveel er dit jaar (YTD) gefactureerd is, hoeveel er
// vorig jaar gefactureerd is, en hoeveel er momenteel "vervallen" is
// (facturen waarvan de vervaldatum verstreken is en die nog niet betaald
// zijn). Het resultaat (alleen de bedragen, niet het token) wordt
// weggeschreven naar de tabel 'financieel_omzet', die het dashboard
// vervolgens gewoon uitleest zoals elke andere tabel.
//
// Beveiliging: alleen een ingelogde manager mag deze functie aanroepen
// (zelfde rolcheck als overal elders in het dashboard). De Moneybird-token en
// de Supabase service-role key komen NOOIT in de respons terecht.
//
// Vereiste secrets (instellen via Supabase Dashboard > Edge Functions > Secrets,
// of `supabase secrets set NAAM=waarde`):
//   MONEYBIRD_TOKEN            — persoonlijk API-token (Bearer token) uit Moneybird
//   MONEYBIRD_ADMINISTRATION_ID — te vinden in de Moneybird-URL als je ingelogd bent
// (SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY staan automatisch al klaar in elke
//  Edge Function, die hoef je niet zelf in te stellen.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

// Haalt alle pagina's van een Moneybird-lijst-endpoint op.
//
// LET OP — eerdere bug: deze functie stopte voorheen na 30 pagina's (= 3000
// facturen). Bij een sync-resultaat van exact "3000 facturen verwerkt" werd
// stilzwijgend afgekapt zodra de administratie méér dan 3000 relevante
// facturen had, met een te lage omzet-YTD tot gevolg (oudere/nieuwere
// facturen die net buiten de eerste 3000 vielen telden niet mee). Moneybird
// geeft zelf geen foutmelding bij het opvragen van een pagina voorbij het
// einde — je krijgt dan gewoon een lege array terug (zie Moneybird API-docs,
// sectie Pagination) — dus we kunnen de cap veilig optrekken: de loop stopt
// hieronder vanzelf zodra een pagina leeg is of korter dan 100 rijen.
// De pagina-limiet hier is alleen nog een noodstop tegen een eventuele
// kapotte lus, geen praktische grens — bij 100 facturen/pagina zou 140
// pagina's al 14.000 facturen toelaten, ruim boven wat deze administratie
// ooit zal bevatten.
//
// Moneybird's rate limit is 150 requests per 5 minuten per IP-adres (zie
// API-docs, sectie Throttling). Bij een 429 ("Too Many Requests") wachten we
// het door Moneybird opgegeven aantal seconden (Retry-After-header, met een
// plafond van 10s) en proberen we dezelfde pagina opnieuw, in plaats van de
// hele sync te laten mislukken.
//
// LET OP — tijdslimiet van de Edge Function zelf: Supabase killt een Edge
// Function-aanroep die te lang loopt met een harde 546 "WORKER_LIMIT" (na
// 150s wall-clock-tijd op het gratis plan, 400s op een betaald plan) en dat
// antwoord heeft GEEN JSON-body — vandaar dat het dashboard dan alleen de
// generieke melding "Edge Function returned a non-2xx status code" kan tonen
// (er is simpelweg niets bruikbaars om uit te lezen). Om dat te voorkomen
// bouwen we hier zelf een tijdsbudget in: zodra dat verstreken is, stoppen we
// met verder pagineren en gaan we door met wat er al binnen is, zodat de
// functie altijd zelf een nette (JSON) respons teruggeeft — desnoods met een
// duidelijke melding dat de sync is afgekapt — in plaats van dat het
// platform de boel hardhandig afbreekt.
async function fetchAllMoneybird(url: string, token: string): Promise<{ rows: any[]; afgekapt: boolean }> {
  const out: any[] = [];
  const MAX_PAGES = 140;
  const DEADLINE_MS = 100_000; // ruime marge onder de 150s-limiet van het gratis plan
  const startedAt = Date.now();
  let afgekapt = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (Date.now() - startedAt > DEADLINE_MS) {
      afgekapt = true;
      console.warn(`fetchAllMoneybird: tijdsbudget bereikt na pagina ${page - 1} (${out.length} facturen), sync gaat door met wat er is opgehaald.`);
      break;
    }
    const pageUrl = `${url}${url.includes("?") ? "&" : "?"}page=${page}&per_page=100`;
    let res = await fetch(pageUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      const retryAfter = Math.min(parseInt(res.headers.get("Retry-After") || "5", 10) || 5, 10);
      await new Promise((r) => setTimeout(r, Math.max(1, retryAfter) * 1000));
      res = await fetch(pageUrl, { headers: { Authorization: `Bearer ${token}` } });
    }
    if (!res.ok) {
      throw new Error(`Moneybird API-fout (${res.status}) bij ${pageUrl}: ${await res.text()}`);
    }
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 100) break; // laatste pagina
  }
  return { rows: out, afgekapt };
}

function normalizeName(s: string) {
  // Vergelijkt op de kern van de bedrijfsnaam: leestekens en hoofdletter-
  // verschillen negeren we, en de rechtsvorm (B.V./BV/N.V./NV/VOF) strippen we
  // aan het einde weg. Zonder dit matchten bv. "Wienerberger BV" en
  // "Wienerberger B.V." niet met elkaar, en "Spie Nederland BV" niet met
  // "SPIE Nederland" — met als gevolg een veel te lange lijst "niet gekoppeld"
  // en nieuwe, dubbele rijen in plaats van de bestaande klant bij te werken.
  return (s || "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(b\s*v|n\s*v|vof)$/i, "")
    .trim();
}

// ── ISO-8601 weeknummer ───────────────────────────────────────────────────
// Zelfde rekenwijze als de browser-helper `getIsoWeekInfo()` in index.html,
// zodat de Moneybird-omzet (hier, per factuurdatum) en de Urenrapportage
// (client-side, per rij-datum) exact dezelfde weekgrenzen gebruiken. Let op:
// het ISO-weekjaar kan afwijken van het kalenderjaar (begin januari/eind
// december kunnen bij week 52/53 van het andere jaar horen).
function getIsoWeekInfo(date: Date): { isoYear: number; isoWeek: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { isoYear, isoWeek };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  try {
    const MONEYBIRD_TOKEN = Deno.env.get("MONEYBIRD_TOKEN");
    const ADMIN_ID = Deno.env.get("MONEYBIRD_ADMINISTRATION_ID");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!MONEYBIRD_TOKEN || !ADMIN_ID) {
      return json({ error: "MONEYBIRD_TOKEN en/of MONEYBIRD_ADMINISTRATION_ID zijn niet ingesteld als secret." }, 500);
    }

    // ── Rolcheck: alleen een manager mag een sync starten ──────────────────────
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return json({ error: "Niet ingelogd of sessie verlopen." }, 401);
    }
    const { data: profile } = await userClient
      .from("profiles")
      .select("rol")
      .eq("id", userData.user.id)
      .single();
    if (!profile || profile.rol !== "manager") {
      return json({ error: "Alleen een manager mag een Moneybird-sync starten." }, 403);
    }

    // ── Facturen ophalen uit Moneybird (alles behalve concepten) ────────────────
    // Let op: meerdere waarden voor dezelfde filter-key worden in de Moneybird-API
    // gescheiden door een pipe (|), niet door een komma — een komma combineert
    // juist verschillende filter-keys (bv. "period:this_year,state:all"). Met een
    // komma hier kreeg Moneybird een ongeldig filter en kwamen er 0 facturen terug.
    const base = `https://moneybird.com/api/v2/${ADMIN_ID}/sales_invoices.json`;
    // 'scheduled' (nog niet verstuurd, staat alleen ingepland) hoort hier niet
    // bij: zo'n factuur is nog geen gerealiseerde omzet. Die liet de omzet-
    // totalen onterecht te hoog uitvallen t.o.v. Moneybird's eigen cijfers.
    const { rows: invoices, afgekapt } = await fetchAllMoneybird(`${base}?filter=state:open|pending_payment|reminded|late|paid|uncollectible`, MONEYBIRD_TOKEN);

    const thisYear = new Date().getFullYear();
    const lastYear = thisYear - 1;
    type VervallenFactuur = { nummer: string; dagen: number };
    type Agg = {
      name: string; contactId: string | null;
      ytd: number; totaal: number; openstaand: number; vervallen: number;
      aantalYtd: number; aantalVervallen: number;
      // Omzet per jaar voor alle jaren behalve het huidige jaar (YTD staat al
      // los in 'ytd') — voedt de subtab "Oude klanten" met meerdere jaren.
      historie: Record<number, number>;
      // Factuurnummer + aantal dagen vervallen per vervallen factuur — voedt de
      // kolommen "Factuurnummers" en "Dagen vervallen (oudste)" op het dashboard.
      vervallenFacturen: VervallenFactuur[];
    };
    const byContact = new Map<string, Agg>();
    // Maandelijkse omzet over ALLE opdrachtgevers samen (voor vergelijking met
    // de begroting in het tabblad Financieel > "Omzetten vs. begroting").
    type MaandAgg = { omzet: number; aantal: number };
    const byMonth = new Map<string, MaandAgg>();
    // Zelfde, maar dan per ISO-week (voor het inzoomen op weekniveau in
    // "Omzetten vs. begroting").
    const byWeek = new Map<string, MaandAgg>();

    for (const inv of invoices) {
      // Concepten (draft), geannuleerde (void) en nog niet verstuurde,
      // ingeplande (scheduled) facturen zijn geen gerealiseerde omzet. We
      // vertrouwen hiervoor niet blind op de filter-string in de Moneybird-
      // API-aanroep hierboven (die kan in theorie toch zo'n factuur teruggeven)
      // — vandaar deze expliciete, harde uitsluiting hier ook nog.
      if (["draft", "void", "scheduled"].includes(inv.state)) continue;
      const contact = inv.contact || {};
      const contactId: string | null = contact.id ?? null;
      const naam: string = (contact.company_name && contact.company_name.trim())
        || [contact.firstname, contact.lastname].filter(Boolean).join(" ").trim()
        || "Onbekende klant";
      const key = contactId || normalizeName(naam);
      if (!byContact.has(key)) {
        byContact.set(key, { name: naam, contactId, ytd: 0, totaal: 0, openstaand: 0, vervallen: 0, aantalYtd: 0, aantalVervallen: 0, historie: {}, vervallenFacturen: [] });
      }
      const agg = byContact.get(key)!;
      const bedrag = parseFloat(inv.total_price_excl_tax_with_discount ?? inv.total_price_excl_tax ?? "0") || 0;
      const invoiceDate = inv.invoice_date ? new Date(inv.invoice_date) : null;
      const invoiceYear = invoiceDate ? invoiceDate.getFullYear() : null;
      const invoiceMonth = invoiceDate ? invoiceDate.getMonth() + 1 : null;
      const isOpen = !["paid", "void", "draft"].includes(inv.state);
      // Vervallen = nog open (onbetaald) ÉN de vervaldatum is verstreken. We
      // vertrouwen hierbij bewust niet (meer) blind op Moneybird's eigen
      // 'late'-status: zodra er een betalingsherinnering is verstuurd zet
      // Moneybird de factuur op status 'reminded' en blijft hij daarin staan
      // — ook als hij allang vervallen is. Met alleen `state === 'late'`
      // werden al die herinnerde-maar-nog-onbetaalde facturen dus helemaal
      // niet meegeteld, wat het "vervallen"-totaal onterecht (veel) te laag
      // liet uitvallen (tot 0, als alle openstaande facturen al herinnerd zijn).
      const dueDate = inv.due_date ? new Date(inv.due_date) : null;
      const isVervallen = isOpen && !!dueDate && dueDate.getTime() < Date.now();

      agg.totaal += bedrag;
      if (isOpen) agg.openstaand += bedrag;
      if (isVervallen) {
        agg.vervallen += bedrag; agg.aantalVervallen += 1;
        // invoice_id is het door Moneybird zelf toegekende, leesbare
        // factuurnummer (bv. "2026-0042"); dueDate (hierboven al bepaald) de
        // vervaldatum waarmee we het aantal dagen vervallen berekenen.
        const dagenVervallen = dueDate ? Math.max(0, Math.floor((Date.now() - dueDate.getTime()) / 86400000)) : 0;
        const nummer = String(inv.invoice_id ?? inv.id ?? "?");
        agg.vervallenFacturen.push({ nummer, dagen: dagenVervallen });
      }
      if (invoiceYear === thisYear) { agg.ytd += bedrag; agg.aantalYtd += 1; }
      else if (invoiceYear !== null) { agg.historie[invoiceYear] = (agg.historie[invoiceYear] || 0) + bedrag; }

      if (invoiceYear && invoiceMonth) {
        const mKey = `${invoiceYear}-${invoiceMonth}`;
        if (!byMonth.has(mKey)) byMonth.set(mKey, { omzet: 0, aantal: 0 });
        const mAgg = byMonth.get(mKey)!;
        mAgg.omzet += bedrag;
        mAgg.aantal += 1;
      }
      if (invoiceDate) {
        const { isoYear, isoWeek } = getIsoWeekInfo(invoiceDate);
        const wKey = `${isoYear}-${isoWeek}`;
        if (!byWeek.has(wKey)) byWeek.set(wKey, { omzet: 0, aantal: 0 });
        const wAgg = byWeek.get(wKey)!;
        wAgg.omzet += bedrag;
        wAgg.aantal += 1;
      }
    }

    // ── Matchen met bestaande opdrachtgevers in 'accounts' ──────────────────────
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: accounts } = await admin.from("accounts").select("naam, moneybird_contact_id");
    const byMoneybirdId = new Map<string, string>();
    const byNormName = new Map<string, string>();
    (accounts || []).forEach((a: any) => {
      if (a.moneybird_contact_id) byMoneybirdId.set(a.moneybird_contact_id, a.naam);
      byNormName.set(normalizeName(a.naam), a.naam);
    });

    const rawRows = [...byContact.values()].map((agg) => {
      let opdrachtgever = agg.name;
      if (agg.contactId && byMoneybirdId.has(agg.contactId)) {
        opdrachtgever = byMoneybirdId.get(agg.contactId)!;
      } else if (byNormName.has(normalizeName(agg.name))) {
        opdrachtgever = byNormName.get(normalizeName(agg.name))!;
      }
      const historieRounded: Record<string, number> = {};
      for (const [jaarStr, bedrag] of Object.entries(agg.historie)) {
        historieRounded[jaarStr] = Math.round(bedrag * 100) / 100;
      }
      // Oudste (= meeste dagen vervallen) factuur eerst, zodat het dashboard
      // simpelweg het eerste item kan pakken voor "Dagen vervallen (oudste)".
      const vervallenFacturenSorted = [...agg.vervallenFacturen].sort((a, b) => b.dagen - a.dagen);
      return {
        opdrachtgever,
        moneybird_contact_id: agg.contactId,
        omzet_ytd: Math.round(agg.ytd * 100) / 100,
        omzet_vorig_jaar: Math.round((agg.historie[lastYear] || 0) * 100) / 100,
        omzet_totaal: Math.round(agg.totaal * 100) / 100,
        openstaand: Math.round(agg.openstaand * 100) / 100,
        vervallen: Math.round(agg.vervallen * 100) / 100,
        omzet_historie: historieRounded,
        vervallen_facturen: vervallenFacturenSorted,
        aantal_facturen_ytd: agg.aantalYtd,
        aantal_facturen_vervallen: agg.aantalVervallen,
        laatst_gesynchroniseerd: new Date().toISOString(),
      };
    });

    // Twee verschillende Moneybird-contacten (verschillende contact-ID's) kunnen
    // op dezelfde echte klant slaan — bv. een klant die per ongeluk dubbel in
    // Moneybird staat, of twee licht verschillend gespelde contactnamen
    // ("SPIE Nederland" / "Spie Nederland BV") die geen van beide een exacte
    // Accountmanagement-match opleveren maar wél, na normalisatie, identiek aan
    // elkaar zijn. We groeperen daarom op de genormaliseerde naam (niet op de
    // ruwe 'opdrachtgever'-string), zodat zulke duo's altijd worden samengevoegd
    // tot één rij — zowel om ze niet dubbel in de "niet gekoppeld"-lijst te
    // tonen, als om te voorkomen dat de upsert dezelfde rij twee keer in één
    // aanroep bijwerkt ("ON CONFLICT DO UPDATE command cannot affect row a
    // second time"). Heeft één van de twee al een echte Accountmanagement-match,
    // dan krijgt de samengevoegde rij die canonieke naam; anders de eerst
    // tegengekomen Moneybird-spelling.
    const merged = new Map<string, (typeof rawRows)[number]>();
    for (const r of rawRows) {
      const normKey = normalizeName(r.opdrachtgever);
      const existing = merged.get(normKey);
      if (!existing) {
        merged.set(normKey, r);
        continue;
      }
      const existingIsKnown = byNormName.has(normalizeName(existing.opdrachtgever));
      const rIsKnown = byNormName.has(normalizeName(r.opdrachtgever));
      const opdrachtgever = existingIsKnown ? existing.opdrachtgever : (rIsKnown ? r.opdrachtgever : existing.opdrachtgever);
      const historieMerged: Record<string, number> = { ...existing.omzet_historie };
      for (const [jaarStr, bedrag] of Object.entries(r.omzet_historie)) {
        historieMerged[jaarStr] = Math.round(((historieMerged[jaarStr] || 0) + bedrag) * 100) / 100;
      }
      merged.set(normKey, {
        ...existing,
        opdrachtgever,
        moneybird_contact_id: existing.moneybird_contact_id || r.moneybird_contact_id,
        omzet_ytd: Math.round((existing.omzet_ytd + r.omzet_ytd) * 100) / 100,
        omzet_vorig_jaar: Math.round((existing.omzet_vorig_jaar + r.omzet_vorig_jaar) * 100) / 100,
        omzet_totaal: Math.round((existing.omzet_totaal + r.omzet_totaal) * 100) / 100,
        openstaand: Math.round((existing.openstaand + r.openstaand) * 100) / 100,
        vervallen: Math.round((existing.vervallen + r.vervallen) * 100) / 100,
        omzet_historie: historieMerged,
        vervallen_facturen: [...existing.vervallen_facturen, ...r.vervallen_facturen].sort((a, b) => b.dagen - a.dagen),
        aantal_facturen_ytd: existing.aantal_facturen_ytd + r.aantal_facturen_ytd,
        aantal_facturen_vervallen: existing.aantal_facturen_vervallen + r.aantal_facturen_vervallen,
      });
    }
    const rows = [...merged.values()];

    if (rows.length) {
      const { error: upsertErr } = await admin.from("financieel_omzet").upsert(rows, { onConflict: "opdrachtgever" });
      if (upsertErr) return json({ error: `Wegschrijven mislukt: ${upsertErr.message}` }, 500);
    }

    // ── Maandelijkse totaalomzet wegschrijven (voor Omzetten vs. begroting) ────
    const maandRows = [...byMonth.entries()].map(([mKey, mAgg]) => {
      const [jaarStr, maandStr] = mKey.split("-");
      return {
        jaar: parseInt(jaarStr, 10),
        maand: parseInt(maandStr, 10),
        omzet: Math.round(mAgg.omzet * 100) / 100,
        aantal_facturen: mAgg.aantal,
      };
    });
    if (maandRows.length) {
      const { error: maandErr } = await admin.from("financieel_omzet_maand").upsert(maandRows, { onConflict: "jaar,maand" });
      if (maandErr) return json({ error: `Wegschrijven (maand) mislukt: ${maandErr.message}` }, 500);
    }

    // ── Wekelijkse totaalomzet wegschrijven (voor inzoomen op weekniveau) ──────
    const weekRows = [...byWeek.entries()].map(([wKey, wAgg]) => {
      const [jaarStr, weekStr] = wKey.split("-");
      return {
        jaar: parseInt(jaarStr, 10),
        week: parseInt(weekStr, 10),
        omzet: Math.round(wAgg.omzet * 100) / 100,
        aantal_facturen: wAgg.aantal,
      };
    });
    if (weekRows.length) {
      const { error: weekErr } = await admin.from("financieel_omzet_week").upsert(weekRows, { onConflict: "jaar,week" });
      if (weekErr) return json({ error: `Wegschrijven (week) mislukt: ${weekErr.message}` }, 500);
    }

    const ongekoppeld = rows.filter((r) => !byNormName.has(normalizeName(r.opdrachtgever)) && !(r.moneybird_contact_id && byMoneybirdId.has(r.moneybird_contact_id)));

    return json({
      ok: true,
      aantalKlanten: rows.length,
      aantalFacturenVerwerkt: invoices.length,
      ongekoppeldeKlanten: ongekoppeld.map((r) => r.opdrachtgever),
      // true als het tijdsbudget van fetchAllMoneybird is bereikt vóórdat alle
      // pagina's bij Moneybird waren opgehaald — de cijfers in dit antwoord
      // zijn dan een onderschatting. Het dashboard toont dit als waarschuwing.
      afgekapt,
    });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
