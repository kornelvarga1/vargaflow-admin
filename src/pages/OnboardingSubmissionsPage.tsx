import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Loader2,
  Search,
  FileText,
  Copy,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertCircle,
  Download,
  ImageIcon,
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";

/** Human-readable labels for the onboarding form fields. */
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

/** Match any submission field against the search query. */
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

export default function OnboardingSubmissionsPage() {
  const { data: submissions, isLoading } = useAllOnboardingSubmissions();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "matched" | "unmatched">("all");

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

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <FileText className="w-5 h-5 text-primary" />
          <h1 className="text-2xl font-display font-bold">Onboarding Submissions</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Every submission from the client onboarding form at{" "}
          <code className="text-xs bg-secondary px-1.5 py-0.5 rounded">vargaflow.com/onboarding-form</code>.
        </p>
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, business, email, phone, city..."
            className="pl-9 bg-secondary border-border"
          />
        </div>
        <div className="flex gap-1 bg-secondary border border-border rounded-md p-1">
          {(["all", "matched", "unmatched"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                filter === f
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {f === "all" && `All (${submissions?.length ?? 0})`}
              {f === "matched" && `Matched (${matchedCount})`}
              {f === "unmatched" && `Unmatched (${unmatchedCount})`}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : !submissions || submissions.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="py-16 text-center">
            <FileText className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">No onboarding submissions yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Submissions from the public form will appear here.
            </p>
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground">No submissions match your search.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((s) => (
            <SubmissionRow key={s.id} submission={s} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Downloads a single photo at its original quality. */
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
      // Stagger slightly so the browser doesn't choke on simultaneous downloads
      await new Promise((r) => setTimeout(r, i * 150));
      downloadPhoto(p.url, p.name || `photo-${i + 1}.jpg`);
    }
  };

  return (
    <div className="mb-4 rounded-md border border-border bg-background/60 p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <ImageIcon className="w-4 h-4 text-primary" />
          <span className="text-sm font-semibold">
            Photos ({photos.length})
          </span>
        </div>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={downloadAll}>
          <Download className="w-3 h-3 mr-1" /> Download All
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {photos.map((p, i) => (
          <div key={`${p.url}-${i}`} className="group relative aspect-square overflow-hidden rounded-md border border-border bg-secondary">
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
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Lightbox */}
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
            <Download className="w-4 h-4 inline mr-1.5" />
            Download Original
          </button>
          <button
            onClick={() => setLightbox(null)}
            className="absolute right-4 top-4 rounded-full bg-background/80 p-2 text-foreground hover:bg-background"
            aria-label="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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
    <Card className="bg-card border-border overflow-hidden">
      {/* Summary row */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-secondary/30 transition-colors text-left"
      >
        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
          <FileText className="w-4 h-4 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium truncate">{data.full_name || "(No name)"}</p>
            {matched ? (
              <Badge variant="outline" className="text-[10px] border-green-500/40 text-green-600 gap-1">
                <CheckCircle2 className="w-3 h-3" /> Matched
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600 gap-1">
                <AlertCircle className="w-3 h-3" /> Unmatched
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate">
            {data.business_name || "—"}
            {data.email ? ` · ${data.email}` : ""}
            {data.business_phone ? ` · ${data.business_phone}` : ""}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {format(new Date(submission.submitted_at), "MMM d, yyyy · h:mm a")}
            {" · "}
            {formatDistanceToNow(new Date(submission.submitted_at), { addSuffix: true })}
          </p>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border bg-secondary/20 px-4 py-3 space-y-2">
          <div className="flex justify-end mb-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" onClick={copyAll}>
              <Copy className="w-3 h-3 mr-1" /> Copy All
            </Button>
          </div>

          {/* Photos */}
          {Array.isArray(data.photos) && data.photos.length > 0 && (
            <PhotoGallery
              photos={data.photos as { name: string; url: string; size?: number }[]}
              submitterName={data.full_name || "submission"}
            />
          )}

          {FIELD_ORDER.map((key) => {
            if (key === "photos") return null;
            const value = data[key];
            if (!value) return null;
            const isLong = typeof value === "string" && value.length > 80;
            const isColor = key === "brand_color" && typeof value === "string" && value.startsWith("#");
            return (
              <div
                key={key}
                className="group grid grid-cols-[140px_1fr_auto] gap-2 items-start py-1.5 border-b border-border/50 last:border-0"
              >
                <span className="text-xs font-medium text-muted-foreground pt-0.5">
                  {FIELD_LABELS[key] || key}
                </span>
                <div className={`text-sm ${isLong ? "whitespace-pre-wrap break-words" : "truncate"}`}>
                  {isColor ? (
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="inline-block w-4 h-4 rounded border border-border"
                        style={{ backgroundColor: value }}
                      />
                      <code className="text-xs">{value}</code>
                    </span>
                  ) : (
                    value
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyField(String(value), FIELD_LABELS[key] || key);
                  }}
                  title={`Copy ${FIELD_LABELS[key] || key}`}
                >
                  <Copy className="w-3 h-3" />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
