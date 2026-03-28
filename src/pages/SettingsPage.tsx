import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Check, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

// ---- My Settings Tab ----

const SETTINGS_FIELDS: { key: string; label: string }[] = [
  { key: "my_name", label: "My Name" },
  { key: "my_phone", label: "My Phone" },
  { key: "my_email", label: "My Email" },
  { key: "company_name", label: "Company Name" },
  { key: "website_url", label: "Website URL" },
  { key: "twilio_phone_number", label: "Twilio Phone Number" },
  { key: "gmb_review_link", label: "GMB Review Link" },
  { key: "quote_form_link", label: "Quote Form Link" },
  { key: "marketing_form_link", label: "Marketing Form Link" },
  { key: "brand_color", label: "Brand Color" },
  { key: "instagram_url", label: "Instagram URL" },
  { key: "software_explanation_video", label: "Software Explanation Video" },
  { key: "testimonials_link", label: "Testimonials Link" },
  { key: "case_study_link", label: "Case Study Link" },
  { key: "demo_calendar_link", label: "Demo Calendar Link" },
  { key: "launch_call_calendar_link", label: "Launch Call Calendar Link" },
  { key: "onboarding_form_link", label: "Onboarding Form Link" },
];

const ADMIN_BUSINESS_ID = "79036fbb-997c-4f7b-b46f-ccc97a64c38d";

function useMySettings() {
  return useQuery({
    queryKey: ["my_settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("settings")
        .select("*")
        .eq("business_id", ADMIN_BUSINESS_ID)
        .single();
      if (error && error.code !== "PGRST116") throw error;
      return data as Record<string, string> | null;
    },
  });
}

function MySettingsTab() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useMySettings();
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const vals: Record<string, string> = {};
    SETTINGS_FIELDS.forEach(({ key }) => {
      vals[key] = (settings as any)?.[key] ?? "";
    });
    setForm(vals);
  }, [settings]);

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      SETTINGS_FIELDS.forEach(({ key }) => { payload[key] = form[key] ?? ""; });

      const { error } = await supabase
        .from("settings")
        .update(payload as any)
        .eq("business_id", ADMIN_BUSINESS_ID);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["my_settings"] });
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
        <div key={key} className="space-y-1.5">
          <Label className="text-sm text-muted-foreground">{label}</Label>
          <Input
            value={form[key] ?? ""}
            onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
            placeholder={`Enter ${label.toLowerCase()}...`}
            className="bg-secondary border-border"
          />
        </div>
      ))}
      <div className="pt-2">
        <Button
          onClick={handleSaveAll}
          disabled={saving}
          className="gradient-primary text-primary-foreground"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
          ) : (
            <Check className="w-4 h-4 mr-1.5" />
          )}
          Save All
        </Button>
      </div>
    </div>
  );
}

// ---- Custom Values Tab ----

interface CustomValue {
  id: string;
  key: string;
  label: string;
  value: string;
  category: string;
  sort_order: number;
}

function useAllCustomValues() {
  return useQuery({
    queryKey: ["all_custom_values"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("custom_values")
        .select("*")
        .order("sort_order");
      if (error) throw error;
      return data as CustomValue[];
    },
  });
}

function CustomValuesTab() {
  const qc = useQueryClient();
  const { data: values, isLoading } = useAllCustomValues();
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const [localLabels, setLocalLabels] = useState<Record<string, string>>({});
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (values) {
      const vals: Record<string, string> = {};
      const labs: Record<string, string> = {};
      values.forEach((v) => {
        vals[v.id] = v.value;
        labs[v.id] = v.label;
      });
      setLocalValues(vals);
      setLocalLabels(labs);
      setDirtyIds(new Set());
    }
  }, [values]);

  const markDirty = (id: string) =>
    setDirtyIds((prev) => new Set(prev).add(id));

  const handleSave = async (id: string) => {
    try {
      const { error } = await supabase
        .from("custom_values")
        .update({ value: localValues[id] ?? "", label: localLabels[id] ?? "" } as any)
        .eq("id", id);
      if (error) throw error;
      setDirtyIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      qc.invalidateQueries({ queryKey: ["all_custom_values"] });
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase
        .from("custom_values")
        .delete()
        .eq("id", id);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["all_custom_values"] });
      toast.success("Deleted");
    } catch {
      toast.error("Failed to delete");
    }
  };

  const handleAdd = async () => {
    if (!newLabel.trim() || !newKey.trim()) {
      toast.error("Label and key are required");
      return;
    }
    setAdding(true);
    try {
      const { error } = await supabase
        .from("custom_values")
        .insert({ label: newLabel.trim(), key: newKey.trim(), value: "" } as any);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["all_custom_values"] });
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
      {(!values || values.length === 0) && (
        <p className="text-sm text-muted-foreground py-2">No custom values yet.</p>
      )}
      {(values || []).map((item) => (
        <div key={item.id} className="flex gap-2 items-center">
          <Input
            value={localLabels[item.id] ?? ""}
            onChange={(e) => {
              setLocalLabels((prev) => ({ ...prev, [item.id]: e.target.value }));
              markDirty(item.id);
            }}
            placeholder="Label"
            className="bg-secondary border-border w-40 shrink-0 text-sm"
          />
          <code className="text-[10px] font-mono text-muted-foreground/60 shrink-0 hidden sm:block w-32 truncate">
            {`{{${item.key}}}`}
          </code>
          <Input
            value={localValues[item.id] ?? ""}
            onChange={(e) => {
              setLocalValues((prev) => ({ ...prev, [item.id]: e.target.value }));
              markDirty(item.id);
            }}
            placeholder="Value"
            className="bg-secondary border-border flex-1 text-sm"
          />
          {dirtyIds.has(item.id) && (
            <Button size="icon" variant="outline" className="h-9 w-9 shrink-0" onClick={() => handleSave(item.id)}>
              <Check className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9 shrink-0 text-destructive hover:text-destructive"
            onClick={() => handleDelete(item.id)}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      ))}

      <Separator className="my-4" />

      {showAddForm ? (
        <div className="space-y-3 p-4 border border-border rounded-lg bg-secondary/30">
          <div className="flex gap-3">
            <div className="space-y-1.5 flex-1">
              <Label className="text-sm">Label</Label>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. Business Name"
                className="bg-secondary border-border"
              />
            </div>
            <div className="space-y-1.5 flex-1">
              <Label className="text-sm">Key</Label>
              <Input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder="e.g. business_name"
                className="bg-secondary border-border font-mono text-sm"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={handleAdd}
              disabled={adding}
              className="gradient-primary text-primary-foreground"
            >
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
          Add New Value
        </Button>
      )}
    </div>
  );
}

// ---- Page ----

export default function SettingsPage() {
  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-display font-bold">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your personal settings and custom template variables.
        </p>
      </div>

      <Tabs defaultValue="my_settings">
        <TabsList className="mb-4">
          <TabsTrigger value="my_settings">My Settings</TabsTrigger>
          <TabsTrigger value="custom_values">Custom Values</TabsTrigger>
        </TabsList>

        <TabsContent value="my_settings">
          <Card className="bg-card border-border shadow-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-display">My Settings</CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4">
              <MySettingsTab />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="custom_values">
          <Card className="bg-card border-border shadow-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-display">Custom Values</CardTitle>
            </CardHeader>
            <Separator />
            <CardContent className="pt-4">
              <CustomValuesTab />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
