import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Base64URL helpers ──────────────────────────────────────────────────────

function b64urlEncode(buf: Uint8Array): string {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

const enc = new TextEncoder();

// ── VAPID JWT ──────────────────────────────────────────────────────────────

async function buildVapidJwt(
  privateKeyB64: string,
  publicKeyB64: string,
  endpoint: string,
  subject: string,
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 43200; // 12 h

  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body   = b64urlEncode(enc.encode(JSON.stringify({ aud: audience, exp, sub: subject })));
  const unsigned = `${header}.${body}`;

  // Build JWK from raw private scalar + uncompressed public point
  const privBytes = b64urlDecode(privateKeyB64);
  const pubBytes  = b64urlDecode(publicKeyB64);

  // pubBytes is uncompressed P-256: 0x04 || x(32) || y(32)
  const x = pubBytes.length === 65 ? pubBytes.slice(1, 33) : pubBytes.slice(0, 32);
  const y = pubBytes.length === 65 ? pubBytes.slice(33, 65) : pubBytes.slice(32, 64);

  const jwk = {
    kty: "EC", crv: "P-256",
    d: b64urlEncode(privBytes),
    x: b64urlEncode(x),
    y: b64urlEncode(y),
  };

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned),
  );

  return `${unsigned}.${b64urlEncode(new Uint8Array(sig))}`;
}

// ── Web Push message encryption (RFC 8291 / aes128gcm) ────────────────────

async function encryptPayload(
  subscriptionKeys: { p256dh: string; auth: string },
  plaintext: string,
): Promise<{ body: Uint8Array; contentEncoding: string }> {
  const clientPub  = b64urlDecode(subscriptionKeys.p256dh);
  const clientAuth = b64urlDecode(subscriptionKeys.auth);
  const plaintextBytes = enc.encode(plaintext);

  // Server ephemeral ECDH key pair
  const serverKP = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey", "deriveBits"],
  );
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKP.publicKey));

  // Import client public key
  const clientKey = await crypto.subtle.importKey(
    "raw", clientPub, { name: "ECDH", namedCurve: "P-256" }, false, [],
  );

  // ECDH shared secret
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: clientKey }, serverKP.privateKey, 256,
  );
  const sharedSecret = new Uint8Array(sharedBits);

  // PRK via HKDF-Extract(salt=auth, ikm=sharedSecret)
  const hkdfShared = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const prkInfo = concat(enc.encode("WebPush: info\x00"), clientPub, serverPubRaw);
  const prkBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: clientAuth, info: prkInfo }, hkdfShared, 256,
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk  = await crypto.subtle.importKey("raw", new Uint8Array(prkBits), "HKDF", false, ["deriveBits"]);

  // Content Encryption Key (128-bit AES-GCM)
  const cekBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: aes128gcm\x00") }, prk, 128,
  );
  // Nonce (96-bit)
  const nonceBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("Content-Encoding: nonce\x00") }, prk, 96,
  );

  const cek = await crypto.subtle.importKey("raw", new Uint8Array(cekBits), "AES-GCM", false, ["encrypt"]);

  // Pad: plaintext || 0x02 (AEAD record delimiter, RFC 8291 §4)
  const padded = concat(plaintextBytes, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: new Uint8Array(nonceBits) }, cek, padded,
  ));

  // aes128gcm content-coding header: salt(16) || rs(4 BE) || keylen(1) || serverPub
  const rs = 4096;
  const header = new Uint8Array(21 + serverPubRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = serverPubRaw.length;
  header.set(serverPubRaw, 21);

  return { body: concat(header, ciphertext), contentEncoding: "aes128gcm" };
}

// ── Main handler ──────────────────────────────────────────────────────────

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

    const sub = row.subscription as {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    };

    const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY")!;
    const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC_KEY")!;
    const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:hello@vargaflow.com";

    const payload = JSON.stringify({ title: title ?? "New message", body: msgBody ?? "", url: "/messages" });
    const { body: encrypted, contentEncoding } = await encryptPayload(sub.keys, payload);
    const jwt = await buildVapidJwt(VAPID_PRIVATE, VAPID_PUBLIC, sub.endpoint, VAPID_SUBJECT);

    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${jwt},k=${VAPID_PUBLIC}`,
        "Content-Encoding": contentEncoding,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(encrypted.byteLength),
        TTL: "300",
      },
      body: encrypted,
    });

    if (!res.ok) {
      const text = await res.text();
      // 410 Gone = subscription expired, clean it up
      if (res.status === 410) {
        await supabase.from("push_subscriptions").delete().eq("business_id", business_id);
        console.log("[push] subscription expired (410), deleted for business:", business_id);
        return new Response(JSON.stringify({ deleted: "expired" }), { status: 200, headers: corsHeaders });
      }
      throw new Error(`Push endpoint ${res.status}: ${text}`);
    }

    console.log("[push] delivered to", sub.endpoint.slice(0, 60));
    return new Response(JSON.stringify({ delivered: true }), { status: 200, headers: corsHeaders });

  } catch (err) {
    console.error("[push] error:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: corsHeaders },
    );
  }
});
