import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Google redirects here after the contractor approves calendar access.
// Exchanges the auth code for tokens and stores the refresh token on the
// business's voice_agents row, keyed by the business_id we passed through
// as `state` in voice-calendar-oauth-start.

function html(body: string) {
  return new Response(
    `<!doctype html><html><body style="font-family: sans-serif; padding: 2rem;">${body}</body></html>`,
    { headers: { "Content-Type": "text/html" } },
  );
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const businessId = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return html(`<h2>Calendar connection cancelled</h2><p>${error}</p>`);
  }
  if (!code || !businessId) {
    return html(`<h2>Something went wrong</h2><p>Missing code or business reference.</p>`);
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
    return html(`<h2>Calendar connection failed</h2><p>${JSON.stringify(tokenData)}</p>`);
  }

  if (!tokenData.refresh_token) {
    return html(
      `<h2>No refresh token received</h2><p>This usually means the account already granted access before. Revoke access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> for this app and try connecting again.</p>`,
    );
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
    return html(`<h2>Calendar connected, but saving it failed</h2><p>${dbError.message}</p>`);
  }

  return html(`<h2>Calendar connected</h2><p>You can close this tab.</p>`);
});
