import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Check, Loader2, Plus, Building2, ArrowLeft, ListChecks } from "lucide-react";
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

// ---- Custom Values Tab ----

function CustomValuesTab({ businessId }: { businessId: string }) {
  const qc = useQueryClient();
  const { data: values, isLoading } = useBusinessCustomValues(businessId);
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [adding, setAdding] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);

  useEffect(() => {
    if (values) {
      const map: Record<string, string> = {};
      values.forEach((v) => (map[v.id] = v.value));
      setLocalValues(map);
      setDirtyIds(new Set());
    }
  }, [values]);

  const handleChange = (id: string, val: string) => {
    setLocalValues((prev) => ({ ...prev, [id]: val }));
    setDirtyIds((prev) => new Set(prev).add(id));
  };

  const handleSave = async (id: string) => {
    try {
      const { error } = await (supabase as any)
        .from("custom_values")
        .update({ value: localValues[id] ?? "" })
        .eq("id", id);
      if (error) throw error;
      setDirtyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
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
    <div className="space-y-4">
      {(!values || values.length === 0) && (
        <p className="text-sm text-muted-foreground py-4">No custom values yet.</p>
      )}
      {(values || []).map((item) => (
        <div key={item.id} className="space-y-1.5">
          <Label className="text-sm text-muted-foreground flex items-center justify-between">
            <span>{item.label}</span>
            <code className="text-[10px] font-mono text-muted-foreground/60">{`{{${item.key}}}`}</code>
          </Label>
          <div className="flex gap-2">
            <Input
              value={localValues[item.id] ?? ""}
              onChange={(e) => handleChange(item.id, e.target.value)}
              placeholder={`Enter ${item.label.toLowerCase()}...`}
              className="bg-secondary border-border"
            />
            {dirtyIds.has(item.id) && (
              <Button size="sm" variant="outline" onClick={() => handleSave(item.id)} className="shrink-0">
                <Check className="w-3 h-3" />
              </Button>
            )}
          </div>
        </div>
      ))}

      <Separator className="my-4" />

      {showAddForm ? (
        <div className="space-y-3 p-4 border border-border rounded-lg bg-secondary/30">
          <div className="space-y-1.5">
            <Label className="text-sm">Label</Label>
            <Input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="e.g. Business Name"
              className="bg-secondary border-border"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">Key (used in templates)</Label>
            <Input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="e.g. business_name"
              className="bg-secondary border-border font-mono text-sm"
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={handleAdd} disabled={adding} className="gradient-primary text-primary-foreground">
              {adding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
              <span className="ml-1.5">Add</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAddForm(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setShowAddForm(true)}>
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          Add new value
        </Button>
      )}
    </div>
  );
}

// ---- Settings Tab ----

function SettingsTab({ businessId }: { businessId: string }) {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useBusinessSettings(businessId);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings) {
      const vals: Record<string, string> = {};
      SETTINGS_FIELDS.forEach(({ key }) => {
        vals[key as string] = (settings[key] as string) ?? "";
      });
      setForm(vals);
    } else {
      const vals: Record<string, string> = {};
      SETTINGS_FIELDS.forEach(({ key }) => { vals[key as string] = ""; });
      setForm(vals);
    }
  }, [settings]);

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      SETTINGS_FIELDS.forEach(({ key }) => { payload[key as string] = form[key as string] ?? ""; });

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
      qc.invalidateQueries({ queryKey: ["settings", businessId] });
      toast.success("Settings saved");
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
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
    <div className="space-y-4">
      {SETTINGS_FIELDS.map(({ key, label }) => (
        <div key={key as string} className="space-y-1.5">
          <Label className="text-sm text-muted-foreground">{label}</Label>
          <Input
            value={form[key as string] ?? ""}
            onChange={(e) => setForm((prev) => ({ ...prev, [key as string]: e.target.value }))}
            placeholder={`Enter ${label.toLowerCase()}...`}
            className="bg-secondary border-border"
          />
        </div>
      ))}
      <div className="pt-2">
        <Button onClick={handleSaveAll} disabled={saving} className="gradient-primary text-primary-foreground">
          {saving ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> : <Check className="w-4 h-4 mr-1.5" />}
          Save All
        </Button>
      </div>
    </div>
  );
}

// ---- Page ----

export default function ClientsPage() {
  const { data: businesses, isLoading } = useBusinesses();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const selected = businesses?.find((b) => b.id === selectedId) ?? null;

  return (
    <div className="flex h-full overflow-hidden animate-fade-in">
      {/* Sidebar — hidden on mobile when a business is selected */}
      <aside className={`${selectedId ? "hidden md:flex" : "flex"} w-full md:w-56 shrink-0 border-r border-border bg-sidebar flex-col overflow-hidden`}>
        <div className="px-4 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Building2 className="w-4 h-4 text-primary" />
            Businesses
          </h2>
        </div>
        <div className="flex-1 overflow-y-auto py-2">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : !businesses || businesses.length === 0 ? (
            <p className="text-xs text-muted-foreground px-4 py-4">No businesses found.</p>
          ) : (
            businesses.map((biz) => (
              <button
                key={biz.id}
                onClick={() => setSelectedId(biz.id)}
                className={`w-full text-left px-4 py-3 text-sm transition-colors flex items-center gap-2 border-b border-border/50 ${
                  selectedId === biz.id
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                }`}
              >
                <Building2 className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{biz.name}</span>
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Main area — hidden on mobile when no business is selected */}
      <main className={`${selectedId ? "flex" : "hidden md:flex"} flex-1 flex-col overflow-auto`}>
        {!selected ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Building2 className="w-10 h-10 text-muted-foreground/30 mb-3" />
            <p className="text-muted-foreground text-sm">Select a business to view details</p>
          </div>
        ) : (
          <div className="p-4 md:p-6 max-w-2xl space-y-6">
            {/* Mobile back button */}
            <div className="md:hidden">
              <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)} className="-ml-2">
                <ArrowLeft className="w-4 h-4 mr-1" />
                All Businesses
              </Button>
            </div>

            <div>
              <h1 className="text-2xl font-display font-bold">{selected.name}</h1>
              <p className="text-xs text-muted-foreground font-mono mt-0.5">{selected.id}</p>
            </div>

            <Tabs defaultValue="custom_values">
              <TabsList className="mb-4">
                <TabsTrigger value="custom_values">Custom Values</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
                <TabsTrigger value="sequences">
                  <ListChecks className="w-3.5 h-3.5 mr-1.5" />
                  Sequences
                </TabsTrigger>
              </TabsList>

              <TabsContent value="custom_values">
                <Card className="bg-card border-border shadow-card">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base font-display">Custom Values</CardTitle>
                  </CardHeader>
                  <Separator />
                  <CardContent className="pt-4">
                    <CustomValuesTab businessId={selected.id} />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="settings">
                <Card className="bg-card border-border shadow-card">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base font-display">Settings</CardTitle>
                  </CardHeader>
                  <Separator />
                  <CardContent className="pt-4">
                    <SettingsTab businessId={selected.id} />
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="sequences">
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Overrides apply only to this business. Steps without an override use the global template.
                  </p>
                  <ClientSequencesTab businessId={selected.id} />
                </div>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </main>
    </div>
  );
}
