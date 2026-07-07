import Anthropic from 'npm:@anthropic-ai/sdk@0.26.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ITK_PROMPT = `Je bent een ervaren recruitment coach. Analyseer dit transcript van een sollicitatiegesprek en geef gestructureerde coachingsfeedback voor de recruiter die het gesprek voerde.

Beoordeel op de volgende aspecten:
- Gebruik van open vragen vs. gesloten vragen
- Exploratie van harde wensen (functie, salaris, regio, werktijden)
- Exploratie van zachte factoren (motivatie, drijfveren, persoonlijke situatie, reden CV)
- Actief luisteren en doorvragen op antwoorden
- Structuur en opbouw van het gesprek
- Afspraken en vervolgacties aan het einde
- Positionering van het bureau als partner

Geef je feedback als een JSON-object met exact deze vier velden:
- "goedGedaan": 2–3 concrete sterke punten die de recruiter liet zien (specifiek en onderbouwd vanuit het transcript)
- "kanBeter": 2–3 concrete verbeterpunten (specifiek, niet algemeen)
- "ontwikkelpunt": 1 prioritair ontwikkelpunt voor het volgende gesprek — formuleer dit als concrete opdracht
- "gespreksagenda": 1 coachingsvraag die de manager kan stellen in het volgende coachingsgesprek

Geef ALLEEN een geldig JSON-object terug, geen uitleg of markdown.`;

const BZK_PROMPT = `Je bent een ervaren sales- en recruitmentcoach. Analyseer dit transcript van een bedrijfsbezoek en geef gestructureerde coachingsfeedback voor de recruiter/accountmanager die het bezoek aflegde.

Beoordeel op de volgende aspecten:
- Relatieopbouw en persoonlijk contact
- Kwalificatie van de wervingsbehoefte (functies, aantallen, urgentie, profiel)
- Verkenning van bedrijfscultuur en werkomgeving
- Commercieel potentieel (meerdere vacatures, groeistrategie, exclusiviteit)
- Concrete vervolgafspraken en acties
- Positionering van het bureau als strategisch partner
- Toon: relatieopbouw vs. transactioneel

Geef je feedback als een JSON-object met exact deze vier velden:
- "goedGedaan": 2–3 concrete sterke punten (specifiek onderbouwd vanuit het transcript)
- "kanBeter": 2–3 concrete verbeterpunten (specifiek, niet algemeen)
- "ontwikkelpunt": 1 prioritair ontwikkelpunt voor het volgende bezoek — formuleer dit als concrete opdracht
- "gespreksagenda": 1 coachingsvraag die de manager kan stellen in het volgende coachingsgesprek

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
    const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') ?? '' });

    const response = await client.messages.create({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 1200,
      messages: [
        {
          role: 'user',
          content: `${prompt}\n\nTranscript:\n${transcript}`,
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
