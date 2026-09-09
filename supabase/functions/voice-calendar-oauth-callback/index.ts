import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Google redirects here after the contractor approves calendar access.
// Exchanges the auth code for tokens and stores the refresh token on the
// business's voice_agents row, keyed by the business_id we passed through
// as `state` in voice-calendar-oauth-start.

// Every exit from this function hands the contractor off to a real page on
// vargaflow.com rather than rendering anything here. Supabase serves edge
// function responses from *.supabase.co as Content-Type: text/plain with a
// `default-src 'none'; sandbox` CSP no matter what headers we set, so HTML
// returned from here reaches the browser as raw markup — which is the last
// thing a client should see at the end of onboarding.
const RESULT_PAGE = "https://vargaflow.com/calendar-connected";

function finish(status: string) {
  return Response.redirect(`${RESULT_PAGE}?status=${encodeURIComponent(status)}`, 302);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const businessId = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    console.warn("[voice-calendar-oauth-callback] consent declined", error);
    return finish("cancelled");
  }
  if (!code || !businessId) {
    return finish("invalid");
  }

  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const redirectUri = `${supabaseUrl}/functions/v1/voice-calendar-oauth-callback`;

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokenData = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error("[voice-calendar-oauth-callback] token exchange failed", tokenData);
    return finish("exchange_failed");
  }

  if (!tokenData.refresh_token) {
    console.warn("[voice-calendar-oauth-callback] no refresh_token in grant", {
      businessId,
      scope: tokenData.scope,
    });
    return finish("already_connected");
  }

  const supabase = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { error: dbError } = await supabase
    .from("voice_agents")
    .update({
      google_refresh_token: tokenData.refresh_token,
      google_calendar_id: "primary",
      updated_at: new Date().toISOString(),
    })
    .eq("business_id", businessId);

  if (dbError) {
    console.error("[voice-calendar-oauth-callback] db update failed", dbError);
    return finish("save_failed");
  }

  return finish("connected");
});
