const SUPABASE_URL = "https://zfmchywjmgykmlhjihls.supabase.co";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!KEY) throw new Error("Set SUPABASE_SERVICE_ROLE_KEY env var");

const h = {
  apikey: KEY,
  Authorization: "Bearer " + KEY,
  "Content-Type": "application/json",
  Prefer: "return=representation",
};

async function api(path, opts = {}) {
  const res = await fetch(SUPABASE_URL + path, { headers: h, ...opts });
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; }
  catch { return { status: res.status, data: text }; }
}

// 1. Get free website sequence ID
const { data: seqs } = await api("/rest/v1/sequences?name=eq.Outreach%20%E2%80%94%20Free%20Website%20Incentive&select=id");
const seqId = seqs[0]?.id;
if (!seqId) throw new Error("Free Website Incentive sequence not found");
console.log("Sequence ID:", seqId);

// 2. Find uncontacted contact_sequences (current_step=0, active)
const { data: rows } = await api(
  `/rest/v1/contact_sequences?sequence_id=eq.${seqId}&status=eq.active&current_step=eq.0&select=id,contact_id`
);
console.log("Uncontacted count:", rows.length);
if (!rows.length) { console.log("Nothing to do."); process.exit(0); }

const contactIds = rows.map((r) => r.contact_id);

// 3. Stop their sequences
const { status: s3 } = await api(
  `/rest/v1/contact_sequences?sequence_id=eq.${seqId}&status=eq.active&current_step=eq.0`,
  { method: "PATCH", body: JSON.stringify({ status: "stopped" }) }
);
console.log("Stop sequences:", s3);

// 4. Cancel their pending messages
const inClause = "in.(" + contactIds.join(",") + ")";
const { status: s4 } = await api(
  `/rest/v1/message_queue?contact_id=${inClause}&status=eq.pending`,
  { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) }
);
console.log("Cancel messages:", s4);

// 5. Clear outreach_angle so enroll-outreach can re-enroll them
const { status: s5 } = await api(
  `/rest/v1/contacts?id=${inClause}`,
  { method: "PATCH", body: JSON.stringify({ outreach_angle: null }) }
);
console.log("Clear outreach_angle:", s5);

// 6. Re-enroll into leads_incentive
const enrollRes = await fetch(SUPABASE_URL + "/functions/v1/enroll-outreach", {
  method: "POST",
  headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
  body: JSON.stringify({ contact_ids: contactIds, workflow: "leads_incentive" }),
});
const result = await enrollRes.json();
console.log("Enrolled:", result.enrolled?.length);
console.log("Skipped:", result.skipped?.length);
if (result.skipped?.length) {
  const reasons = {};
  for (const s of result.skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
  console.log("Skip reasons breakdown:", reasons);
}
