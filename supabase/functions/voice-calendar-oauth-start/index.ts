// Kicks off the Google Calendar OAuth consent flow for a given business.
// Visit this URL in a browser (?business_id=<uuid>) and it redirects to
// Google's consent screen; voice-calendar-oauth-callback handles the return
// trip and stores the refresh token.

Deno.serve((req) => {
  const url = new URL(req.url);
  const businessId = url.searchParams.get("business_id");
  if (!businessId) {
    return new Response("Missing business_id query param", { status: 400 });
  }

  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID")!;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const redirectUri = `${supabaseUrl}/functions/v1/voice-calendar-oauth-callback`;

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
