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
import { normalizePhone } from "@/lib/phone";
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

/** Minimal CSV/TSV parser — handles quoted fields and the separator inside quotes. */
function parseDelimited(text: string, sep: string): string[][] {
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
      else if (ch === sep) {
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

/** Pick the most-likely separator from the first non-empty line.
 *  Tab wins when present and at least as common as comma — covers paste-from-Sheets. */
function detectSeparator(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  return tabs > 0 && tabs >= commas ? "\t" : ",";
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

/** Content-based column sniffer for header-less pastes.
 *  Phone = column with highest ratio of phone-shaped values (>=7 digits, mostly digits).
 *  Email = column with @ symbols.
 *  Name  = first remaining column with letters in most rows. */
function sniffColumns(rows: string[][]): { name: number; phone: number; email: number } {
  const colCount = Math.max(...rows.map((r) => r.length), 0);
  const score = (predicate: (v: string) => boolean) =>
    Array.from({ length: colCount }, (_, c) => {
      const vals = rows.map((r) => (r[c] ?? "").trim()).filter((v) => v.length > 0);
      if (vals.length === 0) return 0;
      return vals.filter(predicate).length / vals.length;
    });

  const phoneScores = score((v) => {
    const digits = v.replace(/\D/g, "");
    return digits.length >= 7 && digits.length / v.length > 0.5;
  });
  const emailScores = score((v) => /@/.test(v));
  const phoneIdx = phoneScores.indexOf(Math.max(...phoneScores));
  const phone = phoneScores[phoneIdx] >= 0.5 ? phoneIdx : 1;
  const emailMax = Math.max(...emailScores);
  const email = emailMax >= 0.5 ? emailScores.indexOf(emailMax) : -1;

  const nameScores = score((v) => /[A-Za-z]/.test(v));
  let name = 0;
  let best = -1;
  for (let c = 0; c < colCount; c++) {
    if (c === phone || c === email) continue;
    if (nameScores[c] > best) { best = nameScores[c]; name = c; }
  }
  return { name, phone, email };
}

export default function CSVImportDialog({ open, onOpenChange }: Props) {
  const [csvText, setCsvText] = useState("");
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const preview = useMemo<ParsedRow[]>(() => {
    if (!csvText.trim()) return [];
    const rows = parseDelimited(csvText, detectSeparator(csvText));
    if (rows.length === 0) return [];
    const header = rows[0];
    const looksLikeHeader =
      header.some((h) => /name|phone|email|business|company/i.test(h));
    const dataRows = looksLikeHeader ? rows.slice(1) : rows;
    const cols = looksLikeHeader ? detectColumns(header) : sniffColumns(dataRows);

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
      // Normalize CSV phones up front so they match stored E.164 values when
      // checking against existing contacts / DNC list.
      const normalizedPreview = preview.map((r) => ({
        ...r,
        phone: normalizePhone(r.phone) ?? r.phone,
      }));
      const phones = normalizedPreview.map((r) => r.phone);
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

      const seenInBatch = new Set<string>();
      for (const row of normalizedPreview) {
        if (!normalizePhone(row.phone)) {
          result.skipped.push({ row, reason: "invalid phone format" });
          continue;
        }
        if (dncPhones.has(row.phone)) {
          result.skipped.push({ row, reason: "on DNC list" });
          continue;
        }
        if (existingPhones.has(row.phone)) {
          result.skipped.push({ row, reason: "phone already in contacts" });
          continue;
        }
        if (seenInBatch.has(row.phone)) {
          result.skipped.push({ row, reason: "duplicate within file" });
          continue;
        }
        seenInBatch.add(row.phone);
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
      // Supabase PostgrestError isn't a JS Error — unwrap message/details/hint manually.
      const e = err as { message?: string; details?: string; hint?: string; code?: string };
      const desc = [e?.message, e?.details, e?.hint, e?.code].filter(Boolean).join(" · ")
        || (err instanceof Error ? err.message : String(err));
      toast.error("Import failed", { description: desc });
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
            Paste from Sheets/Excel or upload a CSV. Columns: name, phone (required), email (optional). Phone is normalized to E.164 (US default). DNC'd numbers and duplicates are skipped.
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
            <Label htmlFor="csv-text" className="text-xs">Or paste rows</Label>
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

