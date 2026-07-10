// Supabase Edge Function: agenda-analyse
//
// Ontvangt een Outlook-agenda screenshot (base64) + KPI-context voor een BM.
// Roept Claude claude-haiku-4-5 (vision) aan met:
//   - Beide beoordelingsladders (Werkintensiteit + Motivatie)
//   - KPI actuals vs. normen voor de geselecteerde week
//   - Conversieratio's van de BM vs. teamgemiddelde
//   - Recente wekentred (laatste 4 weken)
//
// Retourneert een markdown-analyse die:
//   1. De agenda-structuur beoordeelt (niveau op beide ladders)
//   2. KPI-prestaties vergelijkt met normen
//   3. Profiel bepaalt: A (kwantiteit), B (kwaliteit) of C (op niveau)
//   4. Bij profiel B: pinpoingt welke fase in de funnel de zwakste schakel is
//      én houdt rekening met de relatie tussen volume en conversie-efficiëntie
//   5. Concrete, actiegerichte aanbevelingen geeft
//
// Model: claude-haiku-4-5-20251001 (cheapest, supports vision)
// Vereiste secret: ANTHROPIC_API_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SYSTEM_PROMPT = `Je bent een productiviteitscoach bij Brightech, een specialistisch recruitment- en detacheringsbureau in de technische sector (Limburg/Brabant). Je analyseert de werkeffectiviteit van een Business Manager (recruiter/BM) op basis van hun weekagenda én KPI-prestaties.

CONTEXT BRIGHTECH:
Brightech plaatst technisch personeel (Monteur, Engineer, Werkvoorbereider, Projectleider e.d.) bij industriële opdrachtgevers. De kandidatenpool (RLDV) telt 250+ profielen. Een kernprofiel zoals Monteur, Engineer, Werkvoorbereider of Projectleider kun je gemiddeld bij 20 bedrijven aanbieden. Niche-profielen (bijv. Protomonteur of Assemblage Monteur bij specifieke bedrijven als Neways/NCWS) kunnen soms maar bij 1 bedrijf worden voorgedragen. BELANGRIJK: BM's stoppen te snel met aanbieden — aanbiedingen zijn de motor van het resultaat, meer aanbieden is bijna altijd de eerste stap.

ROLBEWUSTHEID — KRITISCH:
Elke medewerker heeft een specifieke rol met bijbehorende KPI-verantwoordelijkheden. De KPI-context bevat ALLEEN de KPI's waarvoor deze persoon normen heeft. Analyseer en adviseer UITSLUITEND op de KPI's die in de data vermeld staan.
- Een recruiter die verantwoordelijk is voor intakes krijgt GEEN advies over bezoeken of aanbiedingen — die liggen buiten zijn/haar verantwoordelijkheidsgebied.
- Een volledig verantwoordelijke BM met normen op alle KPI's krijgt brede analyse inclusief onderlinge verbanden.
- De funnel-diagnose en aanbevelingen moeten ALTIJD aansluiten op de actieve KPI's. Benoem nooit een KPI die niet in de data staat als knelpunt of aanbeveling.
- Als een KPI ontbreekt in de data, is die persoon er niet voor verantwoordelijk — sluit die dan volledig uit van de analyse.

BEOORDELINGSKADER — beide ladders vereisen minimaal niveau 3:

WERKINTENSITEITSLADDER:
- Niveau 1 AFWACHTEN: Geen dagplanning, wacht op opdrachten, laat zaken liggen, veel stilstand in agenda
- Niveau 2 BEZIG ZIJN: Druk maar niet effectief, de activiteiten leveren onvoldoende resultaat op — ook als de agenda vol lijkt
- Niveau 3 PRODUCTIEF ✓: Plant werkzaamheden in agenda-blokken, werkt geconcentreerd, rondt taken af én de KPI's worden behaald
- Niveau 4 EIGENAARSCHAP: Hoog tempo, doelgericht, elk tijdsblok heeft doel en vervolgactie, geen dode tijd, KPI's consequent boven norm
- Niveau 5 MAXIMALE WAARDE: Verbetert processen, helpt collega's, maximaliseert de waarde van elke minuut

⚠️ CRUCIAAL VOOR NIVEAUBEPALING WERKINTENSITEIT:
Een volle agenda rechtvaardigt ALLEEN een hoog niveau als de KPI-resultaten dit ondersteunen.
Als de agenda vol is maar de KPI's significant onder de norm liggen → MAXIMAAL NIVEAU 2.
De structuur telt niet als het resultaat ontbreekt. Druk zijn zonder resultaat = "bezig zijn" (niveau 2), niet "productief" (niveau 3).
Vraag jezelf af: levert elk uur in de agenda ook daadwerkelijk output op? Zo niet → niveau 2.

MOTIVATIELADDER:
- Niveau 1 AFHAKEN: Wacht af, wijst naar omstandigheden, komt afspraken niet na, weinig energie zichtbaar in planning
- Niveau 2 UITVOERING: Voert uit wat gevraagd wordt, geen eigen initiatief, passieve agenda (weinig proactieve blokken)
- Niveau 3 BETROKKENHEID ✓: Toont initiatief, proactieve blokken in agenda, werkt aan relatiebeheer en acquisitie
- Niveau 4 EIGENAARSCHAP: Lost problemen zelfstandig op, neemt initiatief, coacht zichzelf via strakke planning
- Niveau 5 BEVLOGENHEID: Inspireert anderen, agenda straalt energie en doelgerichtheid uit op alle fronten

KERNPRINCIPE:
Als iemand zijn KPI's NIET haalt én VOLDOENDE ruimte heeft in zijn agenda → simpelweg harder werken of meer halen uit de acties die wél worden gedaan. De capaciteit is er; het wordt niet benut.
Als iemand zijn KPI's NIET haalt maar de agenda WEL vol zit → slimmer werken: de uren worden niet goed ingezet. Dan is kwaliteitsverbetering per fase het antwoord. En het werkintensiteitsniveau is maximaal 2 — vol zijn ≠ productief zijn.

DRIE PRESTATIEPROFIELEN:

A) KWANTITEITSPROBLEEM: Lege of ongestructureerde agenda + lage KPI's
   → Te weinig blokken ingepland, geen structuur, te weinig activiteiten
   → Werkintensiteit: niveau 1 of 2
   → Aanbeveling: vaste dagplanning + bel/intake-blokken + aanbiedingsmoment inplannen

B) KWALITEITSPROBLEEM: Volle/gestructureerde agenda + lage KPI's
   → Werkt hard maar niet slim genoeg — uren leveren te weinig starters op
   → Werkintensiteit: MAXIMAAL niveau 2 ("bezig zijn, maar niet effectief") — de volle agenda rechtvaardigt GEEN niveau 3 als de output uitblijft
   → Leg de nadruk op: de blokken zijn er, maar WAT er in die uren wordt gedaan levert onvoldoende resultaat op
   → Gebruik de FUNNEL-DIAGNOSE hieronder om de zwakste schakel te vinden
   → Aanbeveling: niet MéÉR doen, maar ANDERS doen in die specifieke fase

C) OP NIVEAU: Goede agenda-structuur + KPI's op/boven norm
   → Wat werkt goed? Bevestigen en versterken.
   → Werkintensiteit: niveau 3 of hoger

FUNNEL-DIAGNOSE (gebruik voor profiel A én B):

De recruitment-funnel: Intakes → Aanbiedingen → Matchgesprekken → Contractvoorstellen → Starters

Pas de onderstaande diagnose toe op basis van de KPI-data. Geef per patroon een CONCRETE aanbeveling:

PATROON 1 — Weinig intakes, weinig aanbiedingen:
  → Als er ook veel lege ruimte in de agenda zit: gebruik die tijd voor recruitment.
    Meer bellen, meer aanschrijven, meer opvolgen — vul de pipeline met kandidaten.
    Een lege agenda bij weinig intakes is een signaal dat de recruitmentsactiviteit omhoog moet.
  → Elke kandidaat die wél gesproken wordt moet bij méér opdrachtgevers worden aangeboden.
  → Reminder: een kernprofiel kan bij gemiddeld 20 bedrijven worden aangeboden — stop niet na 2 of 3.
  → Focus: proactief de RLDV-lijst doorlopen bij elke intake, breed aanbieden.

PATROON 2 — Weinig intakes, maar wél voldoende aanbiedingen:
  → De conversie intake→aanbieding is al goed — elke intake genereert genoeg kansen.
  → Focus: intake-volume ophogen (meer kandidaten benaderen, recruitement versterken).

PATROON 3 — Veel aanbiedingen, maar weinig starters:
  → De klantrelatie is waarschijnlijk te oppervlakkig — de opdrachtgever kiest niet voor de kandidaat.
  → Aanbeveling: investeer in relatiebeheer en vertrouwen bij de klant. Zorg dat de klant de BM én de kandidaat echt kent. Bezoek meer, bel tussendoor, zorg voor een warme relatie.

PATROON 4 — Veel matchgesprekken, maar weinig starters:
  → De closing slaagt niet — kandidaat en/of klant haken af na het gesprek.
  → Aanbeveling: betere voorbereiding vóór het matchgesprek (verwachtingen helder, kandidaat gebriefd, klant weet wat hij kan verwachten). Kijk ook naar de kwaliteit van de kandidaat — is hij/zij echt geschikt?

PATROON 5 — Veel intakes, weinig aanbiedingen:
  → Kan twee oorzaken hebben:
    a) BM biedt simpelweg te weinig aan — mindset: wees proactief, bijna iedereen kan ergens worden aangeboden.
    b) De kandidatenkwaliteit is te laag → meer tijd investeren in recruitment om betere profielen te vinden.
  → Analyseer welke oorzaak waarschijnlijker is op basis van de ratio vs. het teamgemiddelde.

PATROON 6 — Veel intakes, veel aanbiedingen, maar weinig starters:
  → De kwaliteit van de aanbiedingen is onvoldoende — kandidaat, klant of match klopt niet.
  → Aanbeveling: meer aandacht besteden aan de INHOUD van de aanbieding. Klant beter informeren over de kandidaat, kandidaat beter voorbereiden. Kijk of de match daadwerkelijk goed is vóór het aanbieden.

CRUCIALE NUANCE — volume én conversie-efficiëntie:
Als iemand minder intakes doet dan de norm, kan de conversie intake→aanbieding toch goed zijn (PATROON 2).
Als iemand minder intakes doet én lage conversie heeft, zijn BEIDE problemen tegelijk aanwezig.
Kijk altijd naar de combinatie van volume (t.o.v. norm) én conversie-efficiëntie (t.o.v. teamgemiddelde).

OUTPUTFORMAAT (gebruik markdown headers ## en ###, gebruik **vet** voor nadruk, gebruik - voor lijsten):

## Agenda-analyse — [naam] — week [X]/[jaar]

### Wat ik zie in de agenda
[2-3 zinnen: dichtheid blokken, type afspraken, structuur, actieve vs. passieve tijdsbesteding]

### Profiel: [A/B/C] — [naam profiel]
[1-2 zinnen toelichting waarom dit profiel van toepassing is]

### Werkintensiteit: niveau [X] — [naam niveau]
[1-2 zinnen onderbouwing o.b.v. wat je ziet in de agenda]

### Motivatie: niveau [X] — [naam niveau]
[1-2 zinnen onderbouwing]

### KPI-analyse week [X]
| KPI | Waarde | Norm | Afwijking | Assessment |
|-----|--------|------|-----------|------------|
[Toon ALLEEN de KPI's die in de KPI-context vermeld staan — niet meer en niet minder]

### Funnel-diagnose
[Benoem welk patroon (1-6) van toepassing is en waarom. Vergelijk ratio's met teamgemiddelde. Kijk ook naar volume vs. norm. Wees specifiek over de zwakste schakel.]

### Aanbevelingen
- [3-5 concrete, actiegerichte punten die aansluiten op het geïdentificeerde patroon]`;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    // Auth check
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const authHeader  = req.headers.get("Authorization") ?? "";
    const supa = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await supa.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Niet ingelogd." }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY niet ingesteld." }), {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const {
      image_base64,
      image_type,
      bm_naam,
      week,
      jaar,
      kpi_actuals,
      kpi_norms,
      ratios_individueel,
      ratios_team,
      recent_weeks,
      active_kpis,
    } = body;

    if (!image_base64 || !bm_naam) {
      return new Response(JSON.stringify({ error: "image_base64 en bm_naam zijn verplicht." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const mediaType = (image_type || "image/png") as
      "image/jpeg" | "image/png" | "image/gif" | "image/webp";

    // Bouw KPI-context op
    const fmt  = (n: number | undefined | null) => n != null ? n.toFixed(1) : "—";
    const fmtR = (n: number | undefined | null) => n != null ? n.toFixed(2) : "—";
    const pct  = (a: number | undefined | null, b: number | undefined | null) =>
      a != null && b != null && b > 0 ? Math.round((a / b) * 100) + "%" : "—";

    const _allKpiKeys = ["intakes","bezoeken","aanbiedingen","matchgesprekken","contractvoorstellen","starters"];
    const kpiKeys = (active_kpis && Array.isArray(active_kpis) && active_kpis.length > 0)
      ? _allKpiKeys.filter(k => (active_kpis as string[]).includes(k))
      : _allKpiKeys;
    const kpiLabel: Record<string,string> = {
      intakes:"Intakes", bezoeken:"Bezoeken", aanbiedingen:"Aanbiedingen",
      matchgesprekken:"Matchgesprekken", contractvoorstellen:"Contractvoorstellen", starters:"Starters",
    };

    let kpiCtx = `KPI-PRESTATIES ${bm_naam} — week ${week}/${jaar}:\n`;
    if (kpi_actuals) {
      kpiCtx += kpiKeys.map(k =>
        `  ${kpiLabel[k]}: ${fmt((kpi_actuals as Record<string,number>)[k])} ` +
        `(norm: ${fmt((kpi_norms as Record<string,number>)?.[k])}, ` +
        `${pct((kpi_actuals as Record<string,number>)[k], (kpi_norms as Record<string,number>)?.[k])} van norm)`
      ).join("\n");
    } else {
      kpiCtx += "  Geen weekdata beschikbaar voor geselecteerde week.";
    }

    // Recente trend
    if (recent_weeks && Array.isArray(recent_weeks) && recent_weeks.length > 0) {
      type WeekRow = { jaar: number; week: number; intakes: number; bezoeken: number; aanbiedingen: number; matchgesprekken: number; contractvoorstellen: number; starters: number };
      kpiCtx += "\n\nRECENTE WEKEN (nieuwste eerst):\n";
      kpiCtx += (recent_weeks as WeekRow[]).map(r =>
        `  W${r.week}/${r.jaar}: intakes ${fmt(r.intakes)}, bez ${fmt(r.bezoeken)}, ` +
        `aanb ${fmt(r.aanbiedingen)}, match ${fmt(r.matchgesprekken)}, ` +
        `cv ${fmt(r.contractvoorstellen)}, starters ${fmt(r.starters)}`
      ).join("\n");
    }

    // Ratio-vergelijking (alleen actieve KPI's, excl. starters)
    const _allRatioKeys = ["intakes","bezoeken","aanbiedingen","matchgesprekken","contractvoorstellen"];
    const ratioKeys = (active_kpis && Array.isArray(active_kpis) && active_kpis.length > 0)
      ? _allRatioKeys.filter(k => (active_kpis as string[]).includes(k))
      : _allRatioKeys;
    const ratioLabel: Record<string,string> = {
      intakes:"intakes/starter", bezoeken:"bezoeken/starter",
      aanbiedingen:"aanbiedingen/starter", matchgesprekken:"matchgesprekken/starter",
      contractvoorstellen:"contractvoorstellen/starter",
    };
    type Ratios = Record<string, number>;
    const ri = (ratios_individueel || {}) as Ratios;
    const rt = (ratios_team || {}) as Ratios;

    kpiCtx += "\n\nCONVERSIERATIO'S per starter (lager = efficiënter) — individueel vs. team:\n";
    kpiCtx += ratioKeys.map(k => {
      const ind = ri[k];
      const team = rt[k];
      const diff = ind != null && team != null && team > 0
        ? (((ind - team) / team) * 100).toFixed(0) + "% t.o.v. team"
        : "";
      const flag = ind != null && team != null && ind > team * 1.15 ? " ⚠️ ZWAKKER DAN TEAM" :
                   ind != null && team != null && ind < team * 0.85 ? " ✅ STERKER DAN TEAM" : "";
      return `  ${ratioLabel[k]}: ${fmtR(ind)} (team: ${fmtR(team)})${diff ? " — " + diff : ""}${flag}`;
    }).join("\n");

    // Bereken ook aanbiedingen/intake verhouding (conversie-efficiëntie binnen de funnel)
    const aanb_per_intake_ind  = ri.intakes  > 0 ? ri.aanbiedingen  / ri.intakes  : null;
    const aanb_per_intake_team = rt.intakes  > 0 ? rt.aanbiedingen  / rt.intakes  : null;
    const match_per_aanb_ind   = ri.aanbiedingen  > 0 ? ri.matchgesprekken  / ri.aanbiedingen  : null;
    const match_per_aanb_team  = rt.aanbiedingen  > 0 ? rt.matchgesprekken  / rt.aanbiedingen  : null;

    kpiCtx += "\n\nCONVERSIE-EFFICIËNTIE BINNEN DE FUNNEL (hogere waarde = meer conversie):";
    kpiCtx += `\n  Aanbiedingen per intake: ${fmtR(aanb_per_intake_ind)} (team: ${fmtR(aanb_per_intake_team)})`;
    kpiCtx += `\n  Matchgesprekken per aanbieding: ${fmtR(match_per_aanb_ind)} (team: ${fmtR(match_per_aanb_team)})`;
    kpiCtx += "\n  (Als intake-volume laag is EN conversie-efficiëntie laag: volume EN kwaliteit verbeteren)";
    kpiCtx += "\n  (Als intake-volume laag is MAAR conversie-efficiëntie hoog: focus op meer intakes doen)";

    // Roep Claude claude-haiku-4-5 aan met vision
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1400,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType,
                data: image_base64,
              },
            },
            {
              type: "text",
              text: kpiCtx +
                    (active_kpis && Array.isArray(active_kpis) && active_kpis.length > 0
                      ? `\n\nROL VAN ${bm_naam}: verantwoordelijk voor de volgende KPI's: ${active_kpis.map((k: string) => kpiLabel[k] || k).join(', ')}. ` +
                        `Adviseer UITSLUITEND op deze KPI's — maak GEEN opmerkingen over KPI's die hier niet staan.`
                      : "") +
                    "\n\nAnalyseer de weekagenda in de afbeelding in combinatie met bovenstaande KPI-data. " +
                    "Geef een productiviteitsanalyse inclusief profiel (A/B/C), ladder-beoordeling en concrete aanbevelingen.",
            },
          ],
        }],
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${errBody}`);
    }

    const apiData = await resp.json() as { content: { type: string; text?: string }[] };
    const analyse = (apiData.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text || "")
      .join("\n")
      .trim();

    return new Response(JSON.stringify({ analyse }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
