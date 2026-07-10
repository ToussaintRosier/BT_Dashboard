// Supabase Edge Function: beheer-invite
//
// Verstuurt een uitnodigingsmail aan een nieuwe collega via de Supabase Auth
// Admin API (service role key), en maakt tegelijkertijd een profiel-rij aan.
//
// POST /functions/v1/beheer-invite
// Body (JSON): { email, naam, rol, bm_naam, kleur, begindatum, jaardoel }
//
// Vereiste secrets: SUPABASE_SERVICE_ROLE_KEY

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey     = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Auth check: alleen managers mogen dit aanroepen
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await supaUser.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Niet ingelogd." }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    const { data: callerProfile } = await supaUser
      .from("profiles")
      .select("rol,naam")
      .eq("id", user.id)
      .single();
    if (!callerProfile || callerProfile.rol !== "manager") {
      return new Response(JSON.stringify({ error: "Geen toegang — alleen managers." }), {
        status: 403,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // Request body
    const body = await req.json();
    const { email, naam, rol, bm_naam, kleur, begindatum, einddatum, jaardoel, wachtwoord } = body;
    if (!email || !naam || !rol) {
      return new Response(
        JSON.stringify({ error: "email, naam en rol zijn verplicht." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }
    const geldigeRollen = ["bm", "manager", "backoffice", "kam"];
    if (!geldigeRollen.includes(rol)) {
      return new Response(
        JSON.stringify({ error: "Ongeldige rol. Kies: bm, manager, backoffice of kam." }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // Admin client voor Auth-operaties
    const admin = createClient(supabaseUrl, serviceKey);

    // Stap 1: Account aanmaken — met wachtwoord (direct actief) of via uitnodigingsmail
    let inviteData: { user: { id: string } };
    if (wachtwoord) {
      // Direct account aanmaken met opgegeven wachtwoord (geen e-mail nodig)
      const { data, error: createErr } = await admin.auth.admin.createUser({
        email,
        password: wachtwoord,
        email_confirm: true,   // sla e-mailbevestiging over
        user_metadata: { naam, rol },
      });
      if (createErr) throw new Error("Account aanmaken mislukt: " + createErr.message);
      inviteData = { user: { id: data.user.id } };
    } else {
      // Uitnodigingsmail sturen
      const { data, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { naam, rol },
      });
      if (inviteErr) throw new Error("Uitnodiging mislukt: " + inviteErr.message);
      inviteData = { user: { id: data.user.id } };
    }

    const huidigJaar = new Date().getFullYear();
    const profiel_naam = (rol === "bm" || rol === "kam") ? (bm_naam || naam) : naam;

    // Stap 2: Maak profiel aan
    const { error: profileErr } = await admin.from("profiles").upsert(
      {
        id:         inviteData.user.id,
        naam,
        rol,
        bm_naam:    (rol === "bm" || rol === "kam") ? profiel_naam : null,
        kleur:      kleur || "#1a56db",
        email,
        begindatum: begindatum || null,
        einddatum:  einddatum  || null,
      },
      { onConflict: "id" }
    );
    if (profileErr) throw new Error("Profiel aanmaken mislukt: " + profileErr.message);

    // Stap 3: Sla jaardoel op (als opgegeven en BM/KAM)
    if (jaardoel && (rol === "bm" || rol === "kam")) {
      const { error: doelenErr } = await admin.from("doelen").upsert(
        { naam: profiel_naam, jaar: huidigJaar, jaardoel: Number(jaardoel) },
        { onConflict: "naam,jaar" }
      );
      if (doelenErr) throw new Error("Jaardoel opslaan mislukt: " + doelenErr.message);
    }

    return new Response(
      JSON.stringify({
        success: true,
        user_id: inviteData.user.id,
        message: wachtwoord
          ? `Account aangemaakt voor ${email} — kan direct inloggen`
          : `Uitnodiging verstuurd naar ${email}`,
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
