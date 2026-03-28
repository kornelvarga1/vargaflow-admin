import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { business_id, title, body: msgBody } = await req.json();
    if (!business_id) throw new Error("business_id required");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: row, error } = await supabase
      .from("push_subscriptions")
      .select("subscription")
      .eq("business_id", business_id)
      .single();

    if (error || !row) {
      console.log("[push] no subscription for business:", business_id);
      return new Response(JSON.stringify({ skipped: "no_subscription" }), { status: 200, headers: corsHeaders });
    }

    const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
    const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC_KEY")!;
    const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:hello@vargaflow.com";

    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

    const payload = JSON.stringify({
      title: title ?? "New message",
      body: msgBody ?? "",
      url: "/messages",
    });

    console.log("[push] business:", business_id, "payload:", payload);

    const sub = row.subscription as webpush.PushSubscription;
    console.log("[push] endpoint:", sub.endpoint);

    try {
      const result = await webpush.sendNotification(sub, payload);
      console.log("[push] delivered, statusCode:", result.statusCode);
    } catch (err: unknown) {
      const wpErr = err as { statusCode?: number; body?: string; message?: string };
      console.error("[push] sendNotification failed, statusCode:", wpErr.statusCode, "body:", wpErr.body);

      if (wpErr.statusCode === 410) {
        await supabase.from("push_subscriptions").delete().eq("business_id", business_id);
        console.log("[push] subscription expired (410), deleted for business:", business_id);
        return new Response(JSON.stringify({ deleted: "expired" }), { status: 200, headers: corsHeaders });
      }
      throw new Error(`Push failed ${wpErr.statusCode}: ${wpErr.body ?? wpErr.message}`);
    }

    return new Response(JSON.stringify({ delivered: true }), { status: 200, headers: corsHeaders });

  } catch (err) {
    console.error("[push] error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: corsHeaders },
    );
  }
});
