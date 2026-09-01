// Kicks off the Google Calendar OAuth consent flow for the self-built
// booking system. Visit this URL in a browser (no params needed — always
// connects Kornél's own calendar) and it redirects to Google's consent
// screen; booking-oauth-callback handles the return trip and stores the
// refresh token. Reuses the same GOOGLE_OAUTH_CLIENT_ID/SECRET already
// provisioned for the voice-calendar feature — just a new redirect URI.

import { ADMIN_BUSINESS_ID } from "../_shared/utils.ts";

Deno.serve((req) => {
  const url = new URL(req.url);
  const businessId = url.searchParams.get("business_id") || ADMIN_BUSINESS_ID;

  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const redirectUri = `${supabaseUrl}/functions/v1/booking-oauth-callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar",
    access_type: "offline",
    prompt: "consent", // forces a refresh_token even on repeat connects
    state: businessId,
  });

  return Response.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    302,
  );
});
