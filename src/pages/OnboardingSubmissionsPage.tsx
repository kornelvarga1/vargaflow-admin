import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Search,
  Copy,
  ChevronDown,
  ChevronUp,
  Download,
  ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";

const FIELD_LABELS: Record<string, string> = {
  full_name: "Full Name",
  email: "Email",
  business_phone: "Business Phone",
  business_name: "Business Name",
  trade_type: "Trade",
  license_number: "Contractor License #",
  tax_id: "Tax ID / EIN",
  street_address: "Street Address",
  city: "City",
  state: "State",
  zip: "ZIP",
  years_in_business: "Years in Business",
  current_website: "Current Website",
  google_business_url: "Google Business Profile",
  about_us: "About Us",
  service_areas: "Service Areas",
  services_offered: "Services Offered",
  business_differentiators: "Differentiators",
  business_hours: "Hours of Operation",
  instagram: "Instagram",
  facebook: "Facebook",
  bbb: "BBB",
  tiktok: "TikTok",
  yelp: "Yelp",
  return_customer_discount: "Return Customer Discount",
  brand_color: "Brand Color",
  need_logo: "Needs Logo?",
};

const FIELD_ORDER = [
  "full_name", "email", "business_phone",
  "business_name", "trade_type", "license_number", "tax_id",
  "street_address", "city", "state", "zip",
  "years_in_business",
  "current_website", "google_business_url",
  "about_us", "service_areas", "services_offered",
  "business_differentiators", "business_hours",
  "instagram", "facebook", "bbb", "tiktok", "yelp",
  "return_customer_discount", "brand_color", "need_logo",
];

interface Submission {
  id: string;
  contact_id: string | null;
  business_id: string | null;
  submitted_at: string;
  data: Record<string, any>;
}

function useAllOnboardingSubmissions() {
  return useQuery({
    queryKey: ["all_onboarding_submissions"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("onboarding_submissions")
        .select("*")
        .order("submitted_at", { ascending: false });
      if (error) throw error;
      return data as Submission[];
    },
  });
}

function matchesQuery(s: Submission, q: string) {
  if (!q.trim()) return true;
  const needle = q.toLowerCase();
  const d = s.data || {};
  const haystack = [
    d.full_name, d.email, d.business_phone, d.business_name,
    d.trade_type, d.city, d.state, d.zip, d.street_address,
    d.services_offered, d.service_areas,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

type FilterType = "all" | "matched" | "unmatched";

export default function OnboardingSubmissionsPage() {
  const { data: submissions, isLoading } = useAllOnboardingSubmissions();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");

  const filtered = useMemo(() => {
    if (!submissions) return [];
    return submissions.filter((s) => {
      if (!matchesQuery(s, query)) return false;
      if (filter === "matched") return !!s.contact_id;
      if (filter === "unmatched") return !s.contact_id;
      return true;
    });
  }, [submissions, query, filter]);

  const matchedCount = submissions?.filter((s) => s.contact_id).length ?? 0;
  const unmatchedCount = submissions?.filter((s) => !s.contact_id).length ?? 0;
  const total = submissions?.length ?? 0;

  return (
    <div className="px-4 md:px-6 pt-8 max-w-3xl mx-auto animate-fade-in">
      <header className="px-1 mb-6">
        <h1 className="font-serif text-3xl text-foreground">Submissions</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Onboarding form responses from clients.
        </p>
      </header>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-5">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
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
      ) : !submissions || submissions.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-sm text-muted-foreground">No onboarding submissions yet.</p>
          <p className="text-xs text-muted-foreground mt-1">
            Submissions from the public form will appear here.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-12">No submissions match your search.</p>
      ) : (
        <ul className="bg-card border border-border/60 rounded-2xl divide-y divide-border/40 overflow-hidden">
          {filtered.map((s) => (
            <SubmissionRow key={s.id} submission={s} />
          ))}
        </ul>
      )}

      <div className="h-12" />
    </div>
  );
}

async function downloadPhoto(url: string, filename: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to fetch");
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  } catch (err) {
    console.error(err);
    toast.error("Download failed");
  }
}

function PhotoGallery({
  photos,
  submitterName,
}: {
  photos: { name: string; url: string; size?: number }[];
  submitterName: string;
}) {
  const [lightbox, setLightbox] = useState<number | null>(null);

  const downloadAll = async () => {
    toast.info(`Downloading ${photos.length} photos…`);
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      await new Promise((r) => setTimeout(r, i * 150));
      downloadPhoto(p.url, p.name || `photo-${i + 1}.jpg`);
    }
  };

  return (
    <div className="rounded-xl bg-secondary/30 p-3 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <ImageIcon className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
          <span className="text-xs font-medium text-foreground">Photos ({photos.length})</span>
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={downloadAll}>
          <Download className="w-3 h-3 mr-1" strokeWidth={1.5} /> Download all
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {photos.map((p, i) => (
          <div key={`${p.url}-${i}`} className="group relative aspect-square overflow-hidden rounded-lg border border-border/60 bg-secondary">
            <img
              src={p.url}
              alt={p.name}
              loading="lazy"
              onClick={() => setLightbox(i)}
              className="h-full w-full cursor-pointer object-cover transition-transform group-hover:scale-105"
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                downloadPhoto(p.url, p.name || `${submitterName}-photo-${i + 1}.jpg`);
              }}
              className="absolute bottom-1 right-1 rounded-full bg-background/90 p-1.5 text-foreground opacity-0 shadow-sm transition-opacity hover:bg-background group-hover:opacity-100"
              title="Download original"
            >
              <Download className="w-3.5 h-3.5" strokeWidth={1.5} />
            </button>
          </div>
        ))}
      </div>

      {lightbox !== null && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 p-4"
          onClick={() => setLightbox(null)}
        >
          <img
            src={photos[lightbox].url}
            alt={photos[lightbox].name}
            className="max-h-[90vh] max-w-full rounded object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={(e) => {
              e.stopPropagation();
              downloadPhoto(photos[lightbox].url, photos[lightbox].name || `photo-${lightbox + 1}.jpg`);
            }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-md bg-background px-4 py-2 text-sm font-medium text-foreground shadow hover:bg-secondary"
          >
            <Download className="w-4 h-4 inline mr-1.5" strokeWidth={1.5} />
            Download Original
          </button>
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-4 top-4 rounded-full bg-background/80 p-2 text-foreground hover:bg-background"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

function SubmissionRow({ submission }: { submission: Submission }) {
  const [expanded, setExpanded] = useState(false);
  const data = submission.data || {};
  const matched = !!submission.contact_id;

  const copyField = async (value: string, label: string) => {
    await navigator.clipboard.writeText(value);
    toast.success(`Copied ${label}`);
  };

  const copyAll = async () => {
    const lines = FIELD_ORDER
      .filter((key) => data[key])
      .map((key) => `${FIELD_LABELS[key] || key}: ${data[key]}`);
    await navigator.clipboard.writeText(lines.join("\n"));
    toast.success("Copied entire submission");
  };

  return (
    <li>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-secondary/30 transition-colors text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[15px] font-medium text-foreground truncate">{data.full_name || "(No name)"}</p>
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-border/60 text-[10px] text-muted-foreground">
              <span className={`w-1.5 h-1.5 rounded-full ${matched ? "bg-emerald-400" : "bg-amber-400"}`} />
              {matched ? "Matched" : "Unmatched"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {data.business_name || "—"}
            {data.email ? ` · ${data.email}` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground/80 mt-0.5">
            {format(new Date(submission.submitted_at), "MMM d, yyyy · h:mm a")}
            {" · "}
            {formatDistanceToNow(new Date(submission.submitted_at), { addSuffix: true })}
          </p>
        </div>
        {expanded
          ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
          : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />}
      </button>

      {expanded && (
        <div className="border-t border-border/40 bg-secondary/20 px-4 pt-3 pb-4">
          <div className="flex justify-end mb-3">
            <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={copyAll}>
              <Copy className="w-3 h-3 mr-1" strokeWidth={1.5} /> Copy all
            </Button>
          </div>

          {Array.isArray(data.photos) && data.photos.length > 0 && (
            <PhotoGallery
              photos={data.photos as { name: string; url: string; size?: number }[]}
              submitterName={data.full_name || "submission"}
            />
          )}

          <dl className="space-y-0">
            {FIELD_ORDER.map((key) => {
              if (key === "photos") return null;
              const value = data[key];
              if (!value) return null;
              const isLong = typeof value === "string" && value.length > 80;
              const isColor = key === "brand_color" && typeof value === "string" && value.startsWith("#");
              return (
                <div
                  key={key}
                  className="group grid grid-cols-[140px_1fr_auto] gap-2 items-start py-2 border-b border-border/30 last:border-0"
                >
                  <dt className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground pt-0.5">
                    {FIELD_LABELS[key] || key}
                  </dt>
                  <dd className={`text-sm text-foreground/90 ${isLong ? "whitespace-pre-wrap break-words" : "truncate"}`}>
                    {isColor ? (
                      <span className="inline-flex items-center gap-2">
                        <span
                          className="inline-block w-4 h-4 rounded border border-border/60"
                          style={{ backgroundColor: value }}
                        />
                        <code className="text-xs">{value}</code>
                      </span>
                    ) : (
                      value
                    )}
                  </dd>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      copyField(String(value), FIELD_LABELS[key] || key);
                    }}
                    title={`Copy ${FIELD_LABELS[key] || key}`}
                  >
                    <Copy className="w-3 h-3" strokeWidth={1.5} />
                  </Button>
                </div>
              );
            })}
          </dl>
        </div>
      )}
    </li>
  );
}
