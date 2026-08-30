import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Input } from "@/components/ui/input";
import { Loader2, Search, ChevronDown, ChevronUp, PhoneCall, ExternalLink } from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

interface VoiceDemoCall {
  id: string;
  call_id: string;
  agent_id: string | null;
  to_number: string | null;
  from_number: string | null;
  business_id: string | null;
  matched_contact_id: string | null;
  call_status: string | null;
  start_timestamp: string | null;
  duration_ms: number | null;
  disconnection_reason: string | null;
  transcript: string | null;
  recording_url: string | null;
  call_summary: string | null;
  user_sentiment: string | null;
  call_successful: boolean | null;
}

interface ContactLite {
  id: string;
  full_name: string | null;
  phone: string | null;
}

const AGENT_LABEL: Record<string, string> = {
  agent_7a7f41c6e6bc119f25c0c88fb5: "Jake — Ironclad Plumbing (emergency)",
  agent_f8ee00b8177637fbb39fb9d2b5: "Ryan — Summit Roofing (inspection)",
};

function useVoiceDemoCalls() {
  return useQuery({
    queryKey: ["voice_demo_calls"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("voice_demo_calls")
        .select("*")
        .order("start_timestamp", { ascending: false });
      if (error) throw error;
      return data as VoiceDemoCall[];
    },
    refetchInterval: 60_000,
  });
}

function useMatchedContacts(contactIds: string[]) {
  return useQuery({
    queryKey: ["voice_demo_calls_contacts", contactIds],
    queryFn: async () => {
      if (contactIds.length === 0) return [] as ContactLite[];
      const { data, error } = await (supabase as any)
        .from("contacts")
        .select("id, full_name, phone")
        .in("id", contactIds);
      if (error) throw error;
      return data as ContactLite[];
    },
    enabled: contactIds.length > 0,
  });
}

function formatDuration(ms: number | null) {
  if (!ms) return "—";
  const totalSeconds = Math.round(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type FilterType = "all" | "matched" | "unmatched";

export default function VoiceCallsPage() {
  const { data: calls, isLoading } = useVoiceDemoCalls();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");

  const contactIds = useMemo(
    () => Array.from(new Set((calls ?? []).map((c) => c.matched_contact_id).filter(Boolean))) as string[],
    [calls],
  );
  const { data: contacts } = useMatchedContacts(contactIds);
  const contactById = useMemo(() => {
    const map = new Map<string, ContactLite>();
    (contacts ?? []).forEach((c) => map.set(c.id, c));
    return map;
  }, [contacts]);

  const filtered = useMemo(() => {
    if (!calls) return [];
    return calls.filter((c) => {
      if (filter === "matched" && !c.matched_contact_id) return false;
      if (filter === "unmatched" && c.matched_contact_id) return false;
      if (!query.trim()) return true;
      const needle = query.toLowerCase();
      const contact = c.matched_contact_id ? contactById.get(c.matched_contact_id) : null;
      const haystack = [c.from_number, contact?.full_name, c.call_summary, c.transcript]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }, [calls, query, filter, contactById]);

  const matchedCount = calls?.filter((c) => c.matched_contact_id).length ?? 0;
  const unmatchedCount = calls?.filter((c) => !c.matched_contact_id).length ?? 0;
  const total = calls?.length ?? 0;

  return (
    <div className="px-4 md:px-6 pt-8 max-w-3xl mx-auto animate-fade-in">
      <header className="px-1 mb-6">
        <h1 className="font-serif text-3xl text-foreground">Voice Demo Calls</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every call to the shared AI receptionist demo numbers — including ones that never replied to SMS.
        </p>
      </header>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by number, name, or transcript"
            className="pl-9 h-10 text-base bg-secondary/40 border-0 focus-visible:ring-1 focus-visible:ring-ring/50"
          />
        </div>
        <div role="tablist" className="inline-flex items-center bg-secondary/60 rounded-full p-0.5 self-start">
          {(["all", "matched", "unmatched"] as FilterType[]).map((f) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                filter === f
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {f === "all" && `All ${total}`}
              {f === "matched" && `Matched ${matchedCount}`}
              {f === "unmatched" && `Unmatched ${unmatchedCount}`}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : !calls || calls.length === 0 ? (
        <div className="text-center py-16">
          <PhoneCall className="w-8 h-8 text-muted-foreground/50 mx-auto mb-3" strokeWidth={1.5} />
          <p className="text-sm text-muted-foreground">No calls logged yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Calls to the demo numbers will show up here as they come in.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-12">No calls match your search.</p>
      ) : (
        <ul className="bg-card border border-border/60 rounded-2xl divide-y divide-border/40 overflow-hidden">
          {filtered.map((c) => (
            <CallRow key={c.id} call={c} contact={c.matched_contact_id ? contactById.get(c.matched_contact_id) : undefined} />
          ))}
        </ul>
      )}

      <div className="h-12" />
    </div>
  );
}

function CallRow({ call, contact }: { call: VoiceDemoCall; contact?: ContactLite }) {
  const [expanded, setExpanded] = useState(false);
  const matched = !!call.matched_contact_id;
  const agentLabel = call.agent_id ? AGENT_LABEL[call.agent_id] ?? call.agent_id : "Unknown agent";

  return (
    <li>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-secondary/30 transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[15px] font-medium text-foreground truncate">
              {contact?.full_name || call.from_number || "Unknown caller"}
            </p>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-border/60 text-[10px] text-muted-foreground">
              <span className={`w-1.5 h-1.5 rounded-full ${matched ? "bg-emerald-400" : "bg-amber-400"}`} />
              {matched ? "Matched" : "Unmatched"}
            </span>
            {call.user_sentiment && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full border border-border/60 text-[10px] text-muted-foreground">
                {call.user_sentiment}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {agentLabel}
            {call.from_number ? ` · ${call.from_number}` : ""}
            {" · "}
            {formatDuration(call.duration_ms)}
          </p>
          <p className="text-[11px] text-muted-foreground/80 mt-0.5">
            {call.start_timestamp
              ? `${format(new Date(call.start_timestamp), "MMM d, yyyy · h:mm a")} · ${formatDistanceToNow(new Date(call.start_timestamp), { addSuffix: true })}`
              : "—"}
          </p>
        </div>
        {expanded
          ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
          : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />}
      </button>

      {expanded && (
        <div className="border-t border-border/40 bg-secondary/20 px-4 pt-3 pb-4 space-y-3">
          {matched && contact && (
            <Link
              to={`/contacts/${contact.id}`}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              View contact <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
            </Link>
          )}

          {call.call_summary && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Summary</p>
              <p className="text-sm text-foreground/90">{call.call_summary}</p>
            </div>
          )}

          {call.transcript && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Transcript</p>
              <p className="text-sm text-foreground/90 whitespace-pre-wrap break-words">{call.transcript}</p>
            </div>
          )}

          {call.recording_url && (
            <a
              href={call.recording_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Listen to recording <ExternalLink className="w-3 h-3" strokeWidth={1.5} />
            </a>
          )}

          <p className="text-[11px] text-muted-foreground/70">
            {call.call_status ?? "—"}
            {call.disconnection_reason ? ` · ended: ${call.disconnection_reason}` : ""}
          </p>
        </div>
      )}
    </li>
  );
}
