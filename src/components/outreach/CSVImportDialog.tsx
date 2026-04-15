import { useState, useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Upload } from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface ParsedRow {
  name: string;
  phone: string;
  email?: string;
}

interface ImportResult {
  created: ParsedRow[];
  skipped: { row: ParsedRow; reason: string }[];
}

/** Minimal CSV parser — handles quoted fields and commas inside quotes. */
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ",") {
        cur.push(field);
        field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        cur.push(field);
        field = "";
        if (cur.length > 0 && !(cur.length === 1 && cur[0] === "")) rows.push(cur);
        cur = [];
      } else {
        field += ch;
      }
    }
  }
  if (field.length > 0 || cur.length > 0) {
    cur.push(field);
    if (cur.length > 0 && !(cur.length === 1 && cur[0] === "")) rows.push(cur);
  }
  return rows;
}

/** Normalize to E.164 (US default). Strips non-digits; prepends +1 for 10-digit; prepends + if missing. */
function toE164(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (trimmed.startsWith("+") && digits.length >= 7) return `+${digits}`;
  if (digits.length >= 7) return `+${digits}`;
  return null;
}

function detectColumns(header: string[]): { name: number; phone: number; email: number } {
  const lower = header.map((h) => h.trim().toLowerCase());
  const nameIdx = lower.findIndex((h) => /(^|\W)(name|business|company|full[_ ]?name)(\W|$)/.test(h));
  const phoneIdx = lower.findIndex((h) => /phone|number|mobile|cell/.test(h));
  const emailIdx = lower.findIndex((h) => /email/.test(h));
  return {
    name: nameIdx === -1 ? 0 : nameIdx,
    phone: phoneIdx === -1 ? 1 : phoneIdx,
    email: emailIdx,
  };
}

export default function CSVImportDialog({ open, onOpenChange }: Props) {
  const [csvText, setCsvText] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const preview = useMemo<ParsedRow[]>(() => {
    if (!csvText.trim()) return [];
    const rows = parseCSV(csvText);
    if (rows.length === 0) return [];
    const header = rows[0];
    const looksLikeHeader =
      header.some((h) => /name|phone|email|business|company/i.test(h));
    const dataRows = looksLikeHeader ? rows.slice(1) : rows;
    const cols = looksLikeHeader
      ? detectColumns(header)
      : { name: 0, phone: 1, email: -1 };

    const out: ParsedRow[] = [];
    for (const r of dataRows) {
      const name = (r[cols.name] ?? "").trim();
      const phoneRaw = (r[cols.phone] ?? "").trim();
      const phone = toE164(phoneRaw);
      const email = cols.email >= 0 ? (r[cols.email] ?? "").trim() || undefined : undefined;
      if (!phone) continue;
      out.push({ name: name || phoneRaw || phone, phone, email });
    }
    return out;
  }, [csvText]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
  };

  const handleImport = async () => {
    if (preview.length === 0) {
      toast.error("Nothing to import");
      return;
    }
    setBusy(true);
    const result: ImportResult = { created: [], skipped: [] };

    try {
      const phones = preview.map((r) => r.phone);
      const [{ data: existing }, { data: dnc }] = await Promise.all([
        supabase.from("contacts").select("id, phone").in("phone", phones),
        supabase.from("dnc_list").select("phone").in("phone", phones),
      ]);
      const existingPhones = new Set((existing ?? []).map((c) => c.phone));
      const dncPhones = new Set((dnc ?? []).map((d) => d.phone));

      const toInsert: {
        full_name: string;
        phone: string;
        email: string | null;
        pipeline: string;
        stage: string;
        lead_source: string;
      }[] = [];

      for (const row of preview) {
        if (dncPhones.has(row.phone)) {
          result.skipped.push({ row, reason: "on DNC list" });
          continue;
        }
        if (existingPhones.has(row.phone)) {
          result.skipped.push({ row, reason: "phone already in contacts" });
          continue;
        }
        toInsert.push({
          full_name: row.name,
          phone: row.phone,
          email: row.email ?? null,
          pipeline: "sales",
          stage: "Lead In",
          lead_source: "Cold Outreach",
        });
      }

      if (toInsert.length > 0) {
        const { error } = await supabase.from("contacts").insert(toInsert);
        if (error) throw error;
        result.created = toInsert.map((r) => ({ name: r.full_name, phone: r.phone }));
      }

      qc.invalidateQueries({ queryKey: ["contacts"] });

      if (result.created.length > 0) {
        toast.success(
          `Imported ${result.created.length}${
            result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : ""
          }`,
          {
            description:
              result.skipped.length > 0
                ? skipSummary(result.skipped)
                : "Find them in Contacts, then enroll in SMS Outreach.",
          },
        );
        setCsvText("");
        onOpenChange(false);
      } else {
        toast.error(`Nothing imported — ${result.skipped.length} skipped`, {
          description: skipSummary(result.skipped),
        });
      }
    } catch (err) {
      toast.error("Import failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import CSV</DialogTitle>
          <DialogDescription>
            Paste CSV or upload a file. Columns: name, phone (required), email (optional). Phone is normalized to E.164 (US default). DNC'd numbers and duplicates are skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="csv-file" className="text-xs">Upload CSV file</Label>
            <Input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileUpload}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="csv-text" className="text-xs">Or paste CSV</Label>
            <Textarea
              id="csv-text"
              rows={6}
              className="font-mono text-xs mt-1"
              placeholder={`name,phone,email\nAcme Roofing,+15551234567,hi@acme.com`}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
            />
          </div>
          {preview.length > 0 && (
            <div className="rounded-md border border-border p-2 text-xs">
              <p className="font-medium mb-1">
                Parsed {preview.length} row{preview.length === 1 ? "" : "s"}
              </p>
              <div className="max-h-28 overflow-auto space-y-0.5 text-muted-foreground font-mono">
                {preview.slice(0, 6).map((r, i) => (
                  <div key={i} className="truncate">
                    {r.name} · {r.phone}{r.email ? ` · ${r.email}` : ""}
                  </div>
                ))}
                {preview.length > 6 && <div className="opacity-60">…and {preview.length - 6} more</div>}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={handleImport} disabled={busy || preview.length === 0}>
            {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
            Import {preview.length > 0 ? `(${preview.length})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function skipSummary(skipped: { row: ParsedRow; reason: string }[]): string {
  if (skipped.length === 0) return "";
  if (skipped.length <= 3) return skipped.map((s) => `${s.row.name}: ${s.reason}`).join(" · ");
  return skipped
    .slice(0, 2)
    .map((s) => `${s.row.name}: ${s.reason}`)
    .join(" · ") + ` · +${skipped.length - 2} more`;
}

