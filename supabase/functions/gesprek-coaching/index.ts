import Anthropic from 'npm:@anthropic-ai/sdk@0.26.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ITK_PROMPT = `Je bent een ervaren recruitmentcoach bij BrighTech. Analyseer dit transcript van een intakegesprek en geef diepgaande, inhoudelijke coachingsfeedback op de rol van de INTERVIEWER (de BrighTech-medewerker).

Beoordeel op elk van de volgende criteria — wees concreet en onderbouw met voorbeelden uit het transcript:

1. Actief luisteren: Reageert de interviewer actief op wat de kandidaat zegt, of gaat hij gewoon verder met zijn lijst? Pikt hij signalen op?
2. Positieve beïnvloeding: Stuurt de interviewer het gesprek zodanig dat de kandidaat zijn mening of standpunt bijstelt in een positieve richting?
3. Presentatie Brightech: Verkoopt de interviewer Brightech goed en sluit de pitch aan op de behoeften die de kandidaat eerder heeft aangegeven te hebben?
4. Behoeftebepaling: Is de behoeftebepaling voldoende uitgediept? Weet de interviewer echt wat de kandidaat wil en waarom?
5. Open vragen: Stelt de interviewer voldoende open vragen (wie, wat, hoe, waarom, vertel eens)?
6. Samenvatten: Vat de interviewer tussentijds of aan het einde samen wat hij gehoord heeft?
7. Concrete afspraken: Worden er concrete, duidelijke vervolgafspraken gemaakt aan het einde van het gesprek?
8. Vervolg procedure: Legt de interviewer uit wat de kandidaat kan verwachten qua procedure en tijdlijn?
9. Uitleg dienstverlening: Hoe legt de interviewer de dienstverlening van Brightech uit en hoe reageert de kandidaat daarop?
10. Concreetheid vragen: Zijn de vragen van de interviewer concreet en scherp, en zijn de antwoorden die hij uitlokt ook concreet genoeg?
11. Doorvragen op motieven: Vraagt de interviewer voldoende door om te begrijpen hoe de kandidaat denkt en waarom hij bepaalde keuzes heeft gemaakt?

Geef je feedback als een JSON-object met exact deze vier velden:
- "goedGedaan": 2–3 concrete sterke punten die de interviewer liet zien (specifiek onderbouwd met wat er letterlijk in het gesprek gebeurde)
- "kanBeter": 2–3 concrete verbeterpunten (specifiek en onderbouwd — geen algemene tips)
- "ontwikkelpunt": 1 prioritair ontwikkelpunt voor het volgende gesprek, geformuleerd als een concrete opdracht
- "gespreksagenda": 1 scherpe coachingsvraag die de manager kan stellen in het volgende coachingsgesprek

Geef ALLEEN een geldig JSON-object terug, geen uitleg of markdown.`;

const BZK_PROMPT = `Je bent een ervaren sales- en recruitmentcoach bij BrighTech. Analyseer dit transcript van een bedrijfsbezoek en geef diepgaande, inhoudelijke coachingsfeedback op de rol van de BrighTech-medewerker (de accountmanager/recruiter).

Beoordeel op elk van de volgende criteria — wees concreet en onderbouw met voorbeelden uit het transcript:

1. Actief luisteren: Reageert de accountmanager actief op wat de gesprekspartner zegt, of gaat hij gewoon verder met zijn eigen agenda?
2. Positieve beïnvloeding: Stuurt de accountmanager het gesprek zodanig dat de gesprekspartner zijn mening bijstelt en positiever wordt over samenwerking?
3. Presentatie Brightech: Verkoopt de accountmanager Brightech goed en sluit de pitch aan op de behoeften die de gesprekspartner eerder heeft aangegeven?
4. Behoeftebepaling: Is de wervingsbehoefte voldoende uitgediept? Weet de accountmanager echt wat het bedrijf nodig heeft en waarom?
5. Open vragen: Stelt de accountmanager voldoende open vragen (wie, wat, hoe, waarom, vertel eens)?
6. Samenvatten: Vat de accountmanager tussentijds of aan het einde samen wat hij gehoord heeft?
7. Concrete afspraken: Worden er concrete, meetbare vervolgafspraken gemaakt aan het einde van het gesprek?
8. Vervolg procedure: Legt de accountmanager duidelijk uit wat het vervolg is en wat de gesprekspartner mag verwachten?
9. Uitleg dienstverlening: Hoe legt de accountmanager de dienstverlening van Brightech uit en hoe reageert de gesprekspartner daarop?
10. Concreetheid vragen: Zijn de vragen van de accountmanager concreet en scherp, en zijn de antwoorden die hij uitlokt ook concreet genoeg?
11. Doorvragen op motieven: Vraagt de accountmanager voldoende door om te begrijpen hoe het bedrijf denkt, wat de echte pijnpunten zijn en waarom zij bepaalde keuzes maken?

Geef je feedback als een JSON-object met exact deze vier velden:
- "goedGedaan": 2–3 concrete sterke punten die de accountmanager liet zien (specifiek onderbouwd met wat er letterlijk in het gesprek gebeurde)
- "kanBeter": 2–3 concrete verbeterpunten (specifiek en onderbouwd — geen algemene tips)
- "ontwikkelpunt": 1 prioritair ontwikkelpunt voor het volgende bezoek, geformuleerd als een concrete opdracht
- "gespreksagenda": 1 scherpe coachingsvraag die de manager kan stellen in het volgende coachingsgesprek

Geef ALLEEN een geldig JSON-object terug, geen uitleg of markdown.`;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { transcript, type } = await req.json();

    if (!transcript || transcript.trim().length < 50) {
      return new Response(
        JSON.stringify({ error: 'Transcript te kort of ontbreekt.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const prompt = type === 'bzk' ? BZK_PROMPT : ITK_PROMPT;
    // Begrens transcript tot max ~20.000 tokens om de 200k-limiet niet te overschrijden
    const transcriptCapped = transcript.slice(0, 80000);
    const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '' });

    const response = await client.messages.create({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 1800,
      messages: [
        {
          role: 'user',
          content: `${prompt}\n\nTranscript:\n${transcriptCapped}`,
        },
      ],
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text : '';
    let result: Record<string, string> = {};
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      result = JSON.parse(match ? match[0] : raw);
    } catch (_) {
      result = {};
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('gesprek-coaching error:', err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
