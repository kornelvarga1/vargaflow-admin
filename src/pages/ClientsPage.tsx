import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Plus, Building2, ArrowLeft, Check } from "lucide-react";
import { ClientSequencesTab } from "./SequencesPage";
import { toast } from "sonner";

// ---- Types ----

interface Business {
  id: string;
  name: string;
}

interface CustomValue {
  id: string;
  key: string;
  label: string;
  value: string;
  business_id: string;
}

interface BusinessSettings {
  id: string;
  business_id: string;
  my_name: string | null;
  my_phone: string | null;
  my_email: string | null;
  company_name: string | null;
  twilio_phone_number: string | null;
  gmb_review_link: string | null;
  quote_form_link: string | null;
  marketing_form_link: string | null;
  brand_color: string | null;
}

const SETTINGS_FIELDS: { key: keyof BusinessSettings; label: string }[] = [
  { key: "my_name", label: "My Name" },
  { key: "my_phone", label: "My Phone" },
  { key: "my_email", label: "My Email" },
  { key: "company_name", label: "Company Name" },
  { key: "twilio_phone_number", label: "Twilio Phone Number" },
  { key: "gmb_review_link", label: "GMB Review Link" },
  { key: "quote_form_link", label: "Quote Form Link" },
  { key: "marketing_form_link", label: "Marketing Form Link" },
  { key: "brand_color", label: "Brand Color" },
];

type Tab = "custom_values" | "settings" | "sequences";

const TAB_LABELS: Record<Tab, string> = {
  custom_values: "Custom Values",
  settings: "Settings",
  sequences: "Sequences",
};

// ---- Local helpers ----

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground px-1 pb-2 pt-6">
      {children}
    </h2>
  );
}

function GroupedList({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl bg-card border border-border/60 divide-y divide-border/50 overflow-hidden">
      {children}
    </div>
  );
}

// ---- Hooks ----

function useBusinesses() {
  return useQuery({
    queryKey: ["businesses"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("businesses")
        .select("id, name")
        .order("name");
      if (error) throw error;
      return data as Business[];
    },
  });
}

function useBusinessCustomValues(businessId: string | null) {
  return useQuery({
    queryKey: ["custom_values", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("custom_values")
        .select("*")
        .eq("business_id", businessId)
        .order("sort_order");
      if (error) throw error;
      return data as CustomValue[];
    },
  });
}

function useBusinessSettings(businessId: string | null) {
  return useQuery({
    queryKey: ["settings", businessId],
    enabled: !!businessId,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("settings")
        .select("*")
        .eq("business_id", businessId)
        .maybeSingle();
      if (error) throw error;
      return data as BusinessSettings | null;
    },
  });
}

// ---- Custom Values Section ----

function CustomValuesSection({ businessId }: { businessId: string }) {
  const qc = useQueryClient();
  const { data: values, isLoading } = useBusinessCustomValues(businessId);
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const [savedSnapshot, setSavedSnapshot] = useState<Record<string, string>>({});
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    if (values) {
      const map: Record<string, string> = {};
      values.forEach((v) => (map[v.id] = v.value));
      setLocalValues(map);
      setSavedSnapshot(map);
    }
  }, [values]);

  const handleBlur = async (id: string) => {
    const value = localValues[id] ?? "";
    if ((savedSnapshot[id] ?? "") === value) return;
    try {
      const { error } = await (supabase as any)
        .from("custom_values")
        .update({ value })
        .eq("id", id);
      if (error) throw error;
      setSavedSnapshot((prev) => ({ ...prev, [id]: value }));
      qc.invalidateQueries({ queryKey: ["custom_values", businessId] });
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  };

  const handleAdd = async () => {
    if (!newLabel.trim() || !newKey.trim()) {
      toast.error("Label and key are required");
      return;
    }
    setAdding(true);
    try {
      const { error } = await (supabase as any)
        .from("custom_values")
        .insert({ label: newLabel.trim(), key: newKey.trim(), value: "", business_id: businessId });
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["custom_values", businessId] });
      setNewLabel("");
      setNewKey("");
      setShowAddForm(false);
      toast.success("Value added");
    } catch {
      toast.error("Failed to add value");
    } finally {
      setAdding(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {(!values || values.length === 0) ? (
        <p className="text-sm text-muted-foreground py-4">No custom values yet.</p>
      ) : (
        <GroupedList>
          {values.map((item) => (
            <div key={item.id} className="px-4 py-3 space-y-1.5">
              <Label className="text-xs text-muted-foreground flex items-center justify-between">
                <span>{item.label}</span>
                <code className="text-[10px] font-mono text-muted-foreground/60">{`{{${item.key}}}`}</code>
              </Label>
              <Input
                value={localValues[item.id] ?? ""}
                onChange={(e) => setLocalValues((prev) => ({ ...prev, [item.id]: e.target.value }))}
                onBlur={() => handleBlur(item.id)}
                placeholder={`Enter ${item.label.toLowerCase()}...`}
                className="bg-transparent border-0 px-0 h-9 focus-visible:ring-0 focus-visible:ring-offset-0 text-base"
              />
            </div>
          ))}
        </GroupedList>
      )}

      {showAddForm ? (
        <div className="rounded-2xl bg-card border border-border/60 p-4 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Label</Label>
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. Business Name"
              className="bg-secondary/40 border-0 focus-visible:ring-1 focus-visible:ring-ring/50"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Key (used in templates)</Label>
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="e.g. business_name"
              className="bg-secondary/40 border-0 focus-visible:ring-1 focus-visible:ring-ring/50 font-mono text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd} disabled={adding}>
              {adding ? <Loader2 className="w-3 h-3 mr-1 animate-spin" strokeWidth={1.5} /> : <Check className="w-3 h-3 mr-1" strokeWidth={1.5} />}
              Add
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShowAddForm(true)}>
          <Plus className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.5} />
          Add new value
        </Button>
      )}
    </div>
  );
}

// ---- Settings Section ----

function SettingsSection({ businessId }: { businessId: string }) {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useBusinessSettings(businessId);
  const [form, setForm] = useState<Record<string, string>>({});
  const [savedSnapshot, setSavedSnapshot] = useState<Record<string, string>>({});

  useEffect(() => {
    const vals: Record<string, string> = {};
    SETTINGS_FIELDS.forEach(({ key }) => {
      vals[key as string] = (settings?.[key] as string) ?? "";
    });
    setForm(vals);
    setSavedSnapshot(vals);
  }, [settings]);

  const upsertMutation = useMutation({
    mutationFn: async (payload: Record<string, string>) => {
      if (settings?.id) {
        const { error } = await (supabase as any)
          .from("settings")
          .update(payload)
          .eq("id", settings.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any)
          .from("settings")
          .insert({ ...payload, business_id: businessId });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", businessId] });
    },
  });

  const handleBlur = async (key: string) => {
    const value = form[key] ?? "";
    if ((savedSnapshot[key] ?? "") === value) return;
    try {
      await upsertMutation.mutateAsync({ [key]: value });
      setSavedSnapshot((prev) => ({ ...prev, [key]: value }));
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <GroupedList>
      {SETTINGS_FIELDS.map(({ key, label }) => (
        <div key={key as string} className="px-4 py-3 space-y-1.5">
          <Label className="text-xs text-muted-foreground">{label}</Label>
          <Input
            value={form[key as string] ?? ""}
            onChange={(e) => setForm((prev) => ({ ...prev, [key as string]: e.target.value }))}
            onBlur={() => handleBlur(key as string)}
            placeholder={`Enter ${label.toLowerCase()}...`}
            className="bg-transparent border-0 px-0 h-9 focus-visible:ring-0 focus-visible:ring-offset-0 text-base"
          />
        </div>
      ))}
    </GroupedList>
  );
}

// ---- Page ----

export default function ClientsPage() {
  const { data: businesses, isLoading } = useBusinesses();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("custom_values");

  const selected = businesses?.find((b) => b.id === selectedId) ?? null;

  return (
    <div className="flex h-full overflow-hidden animate-fade-in">
      {/* Sidebar */}
      <aside className={`${selectedId ? "hidden md:flex" : "flex"} w-full md:w-64 shrink-0 border-r border-border/40 flex-col overflow-hidden`}>
        <div className="px-5 pt-8 pb-4">
          <h2 className="font-serif text-3xl text-foreground">Clients</h2>
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : !businesses || businesses.length === 0 ? (
            <p className="text-xs text-muted-foreground px-2 py-4">No businesses found.</p>
          ) : (
            <ul className="space-y-0.5">
              {businesses.map((biz) => (
                <li key={biz.id}>
                  <button
                    onClick={() => { setSelectedId(biz.id); setTab("custom_values"); }}
                    className={`w-full text-left px-3 py-2.5 rounded-xl text-sm transition-colors flex items-center gap-2 ${
                      selectedId === biz.id
                        ? "bg-secondary/60 text-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/40"
                    }`}
                  >
                    <Building2 className="w-4 h-4 shrink-0" strokeWidth={1.5} />
                    <span className="truncate">{biz.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Main area */}
      <main className={`${selectedId ? "flex" : "hidden md:flex"} flex-1 flex-col overflow-auto`}>
        {!selected ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Building2 className="w-6 h-6 text-muted-foreground/50 mb-3" strokeWidth={1.5} />
            <p className="text-sm text-muted-foreground">Select a business to view details</p>
          </div>
        ) : (
          <div className="px-4 md:px-6 pt-4 md:pt-8 max-w-2xl mx-auto md:mx-0 w-full">
            <div className="md:hidden mb-2">
              <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)} className="-ml-2 text-muted-foreground">
                <ArrowLeft className="w-4 h-4 mr-1" strokeWidth={1.5} />
                Back
              </Button>
            </div>

            <header className="px-1 mb-6">
              <h1 className="font-serif text-2xl text-foreground">{selected.name}</h1>
              <p className="text-xs text-muted-foreground font-mono mt-0.5">{selected.id}</p>
            </header>

            <div role="tablist" className="inline-flex items-center bg-secondary/60 rounded-full p-0.5 mb-6">
              {(["custom_values", "settings", "sequences"] as Tab[]).map((t) => (
                <button
                  key={t}
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                    tab === t
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {TAB_LABELS[t]}
                </button>
              ))}
            </div>

            {tab === "custom_values" && (
              <>
                <SectionHeader>Custom Values</SectionHeader>
                <CustomValuesSection businessId={selected.id} />
              </>
            )}

            {tab === "settings" && (
              <>
                <SectionHeader>Business Settings</SectionHeader>
                <SettingsSection businessId={selected.id} />
              </>
            )}

            {tab === "sequences" && (
              <>
                <p className="text-xs text-muted-foreground mb-3 px-1">
                  Overrides apply only to this business. Steps without an override use the global template.
                </p>
                <ClientSequencesTab businessId={selected.id} />
              </>
            )}

            <div className="h-12" />
          </div>
        )}
      </main>
    </div>
  );
}
