import Anthropic from 'npm:@anthropic-ai/sdk@0.26.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { transcript } = await req.json();

    if (!transcript || transcript.trim().length < 20) {
      return new Response(JSON.stringify({ error: 'Transcript te kort of ontbreekt.' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '' });

    const response = await client.messages.create({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `Je analyseert een transcript van een coaching/planningsgesprek (Plan van Aanpak). Haal de relevante informatie eruit en geef een JSON-object terug met de velden die je kunt herkennen. Laat velden weg die niet in het gesprek voorkomen of niet duidelijk zijn.

Velden die je kunt invullen:
- "behaald": "ja" of "nee" — is het weekdoel van vorige week behaald?
- "verklaring": korte verklaring waarom het doel wel of niet behaald is, wat werkte en wat niet
- "nieuw_weekdoel": het nieuwe weekdoel of de planning voor komende week
- "acties": geplande concrete acties en activiteiten (bijv. KPI-acties)
- "vacature_focus": op welke vacature of welk profiel ligt de focus deze week?
- "obstakel": obstakels of knelpunten die besproken zijn
- "focuspunt": het belangrijkste aandachtspunt of prioriteit voor de week
- "team_support": ondersteuning of hulp die de medewerker van het team nodig heeft

Geef ALLEEN een geldig JSON-object terug zonder uitleg, opmerkingen of markdown.

Transcript:
${transcript}`,
        },
      ],
    });

    const raw = response.content[0].type === 'text' ? response.content[0].text : '';
    let fields: Record<string, string> = {};
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      fields = JSON.parse(match ? match[0] : raw);
    } catch (_) {
      fields = {};
    }

    return new Response(JSON.stringify(fields), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('pva-analyse error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
