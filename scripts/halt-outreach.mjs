/**
 * Kill switch for a live outreach send.
 *
 *   node scripts/halt-outreach.mjs                          # dry run, shows the damage
 *   node scripts/halt-outreach.mjs --execute                # halt everything outreach
 *   node scripts/halt-outreach.mjs --angle ai_receptionist --execute
 *   node scripts/halt-outreach.mjs --execute --release-untouched
 *
 * Enrolling is not sending: enroll-outreach queues only step 1, and the cron
 * paces first sends against the daily cap. So a list enrolled all at once goes
 * out over days, and stopping it early means cancelling what is still queued
 * before its scheduled_at comes around.
 *
 * What this does:
 *   1. Cancels every PENDING message_queue row for outreach contacts. Rows
 *      already `sent` are history and rows mid-flight in `processing` are left
 *      alone — the cron owns those and racing it would just orphan a send.
 *   2. Marks the matching contact_sequences `stopped`, so the cron's own
 *      sequence-status gate refuses anything that slips past step 1.
 *
 * With --release-untouched it also clears `outreach_angle` on contacts that
 * never actually received a message. enroll-outreach skips any contact that
 * already has an angle set, so without this those leads are burned: they can
 * never be enrolled again even though nothing was ever sent to them. Contacts
 * that did receive something keep their angle — that record is the whole point.
 */

const SUPABASE_URL = "https://zfmchywjmgykmlhjihls.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) throw new Error("Set SUPABASE_SERVICE_ROLE_KEY env var");

const args = process.argv.slice(2);
const EXECUTE = args.includes("--execute");
const RELEASE = args.includes("--release-untouched");
const angleIdx = args.indexOf("--angle");
const ANGLE = angleIdx !== -1 ? args[angleIdx + 1] : null;

const h = {
  apikey: KEY,
  Authorization: "Bearer " + KEY,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function api(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + path, { headers: h, ...opts });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 300)}`);
  return data;
}

// PostgREST can't filter message_queue by a column on contacts without an
// embed, so pull the outreach contact ids first and filter locally. Chunked
// because a long ?in=() list blows past Cloudflare's URL limit and comes back
// empty with no error.
const CHUNK = 150;
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

const angleFilter = ANGLE ? `&outreach_angle=eq.${encodeURIComponent(ANGLE)}` : "&outreach_angle=not.is.null";
const contacts = await api(`/rest/v1/contacts?select=id,full_name,phone,outreach_angle&pipeline=eq.Outreach${angleFilter}`);
const contactIds = contacts.map((c) => c.id);

console.log(`Scope: ${ANGLE ? `angle "${ANGLE}"` : "all outreach angles"}`);
console.log(`Outreach contacts enrolled: ${contactIds.length}`);

if (contactIds.length === 0) {
  console.log("Nothing enrolled. Nothing to halt.");
  process.exit(0);
}

// --- what is still queued ---
let pending = [];
let sentCount = 0;
for (const ids of chunk(contactIds, CHUNK)) {
  const inList = `(${ids.join(",")})`;
  pending.push(...await api(`/rest/v1/message_queue?select=id,contact_id,scheduled_at,metadata&status=eq.pending&contact_id=in.${inList}`));
  const sent = await api(`/rest/v1/message_queue?select=id&status=eq.sent&contact_id=in.${inList}`);
  sentCount += sent.length;
}

const contactedIds = new Set();
for (const ids of chunk(contactIds, CHUNK)) {
  const rows = await api(`/rest/v1/message_queue?select=contact_id&status=eq.sent&contact_id=in.(${ids.join(",")})`);
  rows.forEach((r) => contactedIds.add(r.contact_id));
}
const untouched = contactIds.filter((id) => !contactedIds.has(id));

console.log(`  already sent:      ${sentCount} message(s) to ${contactedIds.size} contact(s)`);
console.log(`  pending (will cancel): ${pending.length}`);
console.log(`  never contacted:   ${untouched.length} contact(s)${RELEASE ? " — will be released for re-enrolment" : ""}`);

const byStep = pending.reduce((acc, m) => {
  const s = m.metadata?.step_order ?? "?";
  acc[s] = (acc[s] ?? 0) + 1;
  return acc;
}, {});
console.log("  pending by step:  ", byStep);

if (!EXECUTE) {
  console.log("\nDRY RUN — nothing changed. Re-run with --execute to halt.");
  process.exit(0);
}

// --- halt ---
let cancelled = 0;
for (const ids of chunk(pending.map((p) => p.id), CHUNK)) {
  const rows = await api(`/rest/v1/message_queue?id=in.(${ids.join(",")})&status=eq.pending`, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled" }),
  });
  cancelled += rows.length;
}
console.log(`Cancelled ${cancelled} pending message(s).`);

let stopped = 0;
for (const ids of chunk(contactIds, CHUNK)) {
  const rows = await api(`/rest/v1/contact_sequences?contact_id=in.(${ids.join(",")})&status=eq.active`, {
    method: "PATCH",
    body: JSON.stringify({ status: "stopped" }),
  });
  stopped += rows.length;
}
console.log(`Stopped ${stopped} active sequence(s).`);

if (RELEASE && untouched.length) {
  let released = 0;
  for (const ids of chunk(untouched, CHUNK)) {
    const rows = await api(`/rest/v1/contacts?id=in.(${ids.join(",")})`, {
      method: "PATCH",
      body: JSON.stringify({ outreach_angle: null, stage: "Cold List" }),
    });
    released += rows.length;
  }
  console.log(`Released ${released} never-contacted contact(s) back to Cold List for re-enrolment.`);
}

const stillPending = await api(`/rest/v1/message_queue?select=id&status=eq.pending&limit=5`);
console.log(`\nHalted. Pending queue now holds ${stillPending.length} row(s) (all pipelines).`);
console.log("Anything in 'processing' was left for the cron to finish — re-run in a minute to confirm it settled.");
