import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Loader2, Plus, Trash2, Check, LogOut, Bell, Sun, Moon, Monitor } from "lucide-react";
import { toast } from "sonner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme, type Theme } from "@/hooks/useTheme";
import { requestNotificationPermission, getNotificationPermissionState } from "@/hooks/usePushNotifications";
import { ADMIN_BUSINESS_ID } from "@/lib/constants";

// ---- Settings field groups ----

type FieldGroup = {
  label: string;
  fields: { key: string; label: string }[];
};

const FIELD_GROUPS: FieldGroup[] = [
  {
    label: "Identity",
    fields: [
      { key: "my_name", label: "My Name" },
      { key: "my_phone", label: "My Phone" },
      { key: "my_email", label: "My Email" },
    ],
  },
  {
    label: "Business",
    fields: [
      { key: "company_name", label: "Company Name" },
      { key: "website_url", label: "Website URL" },
      { key: "twilio_phone_number", label: "Twilio Phone Number" },
      { key: "brand_color", label: "Brand Color" },
      { key: "instagram_url", label: "Instagram URL" },
    ],
  },
  {
    label: "Links",
    fields: [
      { key: "gmb_review_link", label: "GMB Review Link" },
      { key: "quote_form_link", label: "Quote Form Link" },
      { key: "marketing_form_link", label: "Marketing Form Link" },
      { key: "software_explanation_video", label: "Software Explanation Video" },
      { key: "testimonials_link", label: "Testimonials Link" },
      { key: "case_study_link", label: "Case Study Link" },
      { key: "demo_calendar_link", label: "Demo Calendar Link" },
      { key: "launch_call_calendar_link", label: "Launch Call Calendar Link" },
      { key: "onboarding_form_link", label: "Onboarding Form Link" },
    ],
  },
];

const ALL_FIELDS = FIELD_GROUPS.flatMap((g) => g.fields);

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground px-4 pb-2 pt-8">
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

// ---- Outreach Sending Section ----

// Day toggles: Mon-first (business convention) but the underlying ints use JS getDay() (0=Sun).
const DAY_TOGGLES: { code: string; label: string; index: number }[] = [
  { code: "Mo", label: "Mon", index: 1 },
  { code: "Tu", label: "Tue", index: 2 },
  { code: "We", label: "Wed", index: 3 },
  { code: "Th", label: "Thu", index: 4 },
  { code: "Fr", label: "Fri", index: 5 },
  { code: "Sa", label: "Sat", index: 6 },
  { code: "Su", label: "Sun", index: 0 },
];

const TIMEZONE_OPTIONS = [
  { value: "America/New_York", label: "Eastern (ET)" },
  { value: "America/Chicago", label: "Central (CT)" },
  { value: "America/Denver", label: "Mountain (MT)" },
  { value: "America/Phoenix", label: "Arizona (no DST)" },
  { value: "America/Los_Angeles", label: "Pacific (PT)" },
];

interface OutreachConfig {
  daily_send_cap: number;
  send_window_start: number;
  send_window_end: number;
  send_days_of_week: number[];
  outreach_timezone: string;
  hourly_throttle: number | null;
}

function OutreachSendingSection() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useMySettings();
  const [cfg, setCfg] = useState<OutreachConfig>({
    daily_send_cap: 20,
    send_window_start: 8,
    send_window_end: 17,
    send_days_of_week: [1, 2, 3, 4, 5],
    outreach_timezone: "America/Chicago",
    hourly_throttle: null,
  });
  const [hourlyText, setHourlyText] = useState("");

  useEffect(() => {
    if (!settings) return;
    const s = settings as any;
    const next: OutreachConfig = {
      daily_send_cap: s.daily_send_cap ?? 20,
      send_window_start: s.send_window_start ?? 8,
      send_window_end: s.send_window_end ?? 17,
      send_days_of_week: Array.isArray(s.send_days_of_week) ? s.send_days_of_week : [1, 2, 3, 4, 5],
      outreach_timezone: s.outreach_timezone ?? "America/Chicago",
      hourly_throttle:
        typeof s.hourly_throttle === "number" ? s.hourly_throttle : null,
    };
    setCfg(next);
    setHourlyText(next.hourly_throttle == null ? "" : String(next.hourly_throttle));
  }, [settings]);

  const persist = async (patch: Partial<OutreachConfig>) => {
    try {
      const { error } = await supabase
        .from("settings")
        .update(patch as any)
        .eq("business_id", ADMIN_BUSINESS_ID);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["my_settings"] });
      toast.success("Saved");
    } catch (e) {
      toast.error("Failed to save");
    }
  };

  const onCapBlur = () => {
    const n = Math.max(0, Math.floor(Number(cfg.daily_send_cap) || 0));
    if (n !== (settings as any)?.daily_send_cap) persist({ daily_send_cap: n });
  };

  const onWindowBlur = (which: "start" | "end") => {
    const cur =
      which === "start"
        ? Math.max(0, Math.min(23, Math.floor(Number(cfg.send_window_start) || 0)))
        : Math.max(0, Math.min(24, Math.floor(Number(cfg.send_window_end) || 0)));
    const key = which === "start" ? "send_window_start" : "send_window_end";
    if (cur !== (settings as any)?.[key]) persist({ [key]: cur } as Partial<OutreachConfig>);
  };

  const onDaysChange = (codes: string[]) => {
    const next = DAY_TOGGLES.filter((d) => codes.includes(d.code))
      .map((d) => d.index)
      .sort((a, b) => a - b);
    setCfg((c) => ({ ...c, send_days_of_week: next }));
    persist({ send_days_of_week: next });
  };

  const onTimezoneChange = (val: string) => {
    setCfg((c) => ({ ...c, outreach_timezone: val }));
    persist({ outreach_timezone: val });
  };

  const onHourlyBlur = () => {
    const raw = hourlyText.trim();
    const next = raw === "" ? null : Math.max(0, Math.floor(Number(raw) || 0));
    if (next !== cfg.hourly_throttle) persist({ hourly_throttle: next });
  };

  // Computed pace preview
  const windowHours = Math.max(0, cfg.send_window_end - cfg.send_window_start);
  let paceText = "";
  if (cfg.daily_send_cap <= 0) {
    paceText = "Pacing off (daily cap is 0).";
  } else if (windowHours <= 0) {
    paceText = "Send window has no hours — nothing will fire.";
  } else {
    const intervalSec = Math.floor((windowHours * 3600) / cfg.daily_send_cap);
    const intervalMin = Math.max(1, Math.round(intervalSec / 60));
    paceText = `${cfg.daily_send_cap}/day across ${windowHours}h ≈ 1 every ${intervalMin} min`;
  }

  const selectedCodes = DAY_TOGGLES.filter((d) => cfg.send_days_of_week.includes(d.index)).map((d) => d.code);

  return (
    <>
      <SectionHeader>Outreach Sending</SectionHeader>
      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <GroupedList>
          <div className="px-4 py-3 space-y-1.5">
            <Label className="text-xs text-muted-foreground">Daily send cap</Label>
            <Input
              type="number"
              min={0}
              value={String(cfg.daily_send_cap)}
              onChange={(e) =>
                setCfg((c) => ({ ...c, daily_send_cap: Number(e.target.value) }))
              }
              onBlur={onCapBlur}
              className="bg-transparent border-0 px-0 h-9 focus-visible:ring-0 focus-visible:ring-offset-0 text-base"
            />
            <p className="text-[11px] text-muted-foreground/80">{paceText}</p>
          </div>

          <div className="px-4 py-3 space-y-1.5">
            <Label className="text-xs text-muted-foreground">Send window (hours)</Label>
            <div className="flex items-center gap-3">
              <Input
                type="number"
                min={0}
                max={23}
                value={String(cfg.send_window_start)}
                onChange={(e) =>
                  setCfg((c) => ({ ...c, send_window_start: Number(e.target.value) }))
                }
                onBlur={() => onWindowBlur("start")}
                className="bg-transparent border-0 px-0 h-9 focus-visible:ring-0 focus-visible:ring-offset-0 text-base w-16"
              />
              <span className="text-muted-foreground text-sm">to</span>
              <Input
                type="number"
                min={0}
                max={24}
                value={String(cfg.send_window_end)}
                onChange={(e) =>
                  setCfg((c) => ({ ...c, send_window_end: Number(e.target.value) }))
                }
                onBlur={() => onWindowBlur("end")}
                className="bg-transparent border-0 px-0 h-9 focus-visible:ring-0 focus-visible:ring-offset-0 text-base w-16"
              />
              <span className="text-[11px] text-muted-foreground/80 ml-2">
                in {cfg.outreach_timezone.replace("America/", "")}
              </span>
            </div>
          </div>

          <div className="px-4 py-3 space-y-2">
            <Label className="text-xs text-muted-foreground">Allowed days</Label>
            <ToggleGroup
              type="multiple"
              value={selectedCodes}
              onValueChange={onDaysChange}
              className="justify-start gap-1 rounded-lg bg-muted p-0.5 w-fit"
            >
              {DAY_TOGGLES.map((d) => (
                <ToggleGroupItem
                  key={d.code}
                  value={d.code}
                  aria-label={d.label}
                  className="h-8 px-2.5 rounded-md text-xs text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm"
                >
                  {d.code}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <div className="px-4 py-3 space-y-1.5">
            <Label className="text-xs text-muted-foreground">Timezone</Label>
            <Select value={cfg.outreach_timezone} onValueChange={onTimezoneChange}>
              <SelectTrigger className="bg-transparent border-0 px-0 h-9 focus:ring-0 focus:ring-offset-0 text-base [&>span]:text-base">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONE_OPTIONS.map((tz) => (
                  <SelectItem key={tz.value} value={tz.value}>
                    {tz.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="px-4 py-3 space-y-1.5">
            <Label className="text-xs text-muted-foreground">Hourly throttle (optional)</Label>
            <Input
              type="number"
              min={0}
              placeholder="off"
              value={hourlyText}
              onChange={(e) => setHourlyText(e.target.value)}
              onBlur={onHourlyBlur}
              className="bg-transparent border-0 px-0 h-9 focus-visible:ring-0 focus-visible:ring-offset-0 text-base"
            />
            <p className="text-[11px] text-muted-foreground/80">
              Safety cap on top of pacing. Leave blank to rely on distribution only.
            </p>
          </div>
        </GroupedList>
      )}
    </>
  );
}

// ---- Custom Values Section ----

function CustomValuesSection() {
  const qc = useQueryClient();
  const { data: values, isLoading } = useAllCustomValues();
  const [localValues, setLocalValues] = useState<Record<string, string>>({});
  const [localLabels, setLocalLabels] = useState<Record<string, string>>({});
  const [savedSnapshot, setSavedSnapshot] = useState<Record<string, { value: string; label: string }>>({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newKey, setNewKey] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (values) {
      const vals: Record<string, string> = {};
      const labs: Record<string, string> = {};
      const snap: Record<string, { value: string; label: string }> = {};
      values.forEach((v) => {
        vals[v.id] = v.value;
        labs[v.id] = v.label;
        snap[v.id] = { value: v.value, label: v.label };
      });
      setLocalValues(vals);
      setLocalLabels(labs);
      setSavedSnapshot(snap);
    }
  }, [values]);

  const handleBlur = async (id: string) => {
    const value = localValues[id] ?? "";
    const label = localLabels[id] ?? "";
    const snap = savedSnapshot[id];
    if (snap && snap.value === value && snap.label === label) return;
    try {
      const { error } = await supabase
        .from("custom_values")
        .update({ value, label } as any)
        .eq("id", id);
      if (error) throw error;
      setSavedSnapshot((prev) => ({ ...prev, [id]: { value, label } }));
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

  return (
    <>
      <SectionHeader>Custom Values</SectionHeader>
      {isLoading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {(!values || values.length === 0) ? (
            <p className="text-sm text-muted-foreground px-4">No custom values yet.</p>
          ) : (
            <GroupedList>
              {values.map((item) => (
                <div key={item.id} className="px-4 py-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Input
                      value={localLabels[item.id] ?? ""}
                      onChange={(e) => setLocalLabels((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      onBlur={() => handleBlur(item.id)}
                      placeholder="Label"
                      className="bg-transparent border-0 px-0 h-7 focus-visible:ring-0 focus-visible:ring-offset-0 text-sm font-medium"
                    />
                    <code className="text-[10px] font-mono text-muted-foreground/60 shrink-0 hidden sm:block">
                      {`{{${item.key}}}`}
                    </code>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleDelete(item.id)}
                    >
                      <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                    </Button>
                  </div>
                  <Input
                    value={localValues[item.id] ?? ""}
                    onChange={(e) => setLocalValues((prev) => ({ ...prev, [item.id]: e.target.value }))}
                    onBlur={() => handleBlur(item.id)}
                    placeholder="Value"
                    className="bg-transparent border-0 px-0 h-8 focus-visible:ring-0 focus-visible:ring-offset-0 text-base"
                  />
                </div>
              ))}
            </GroupedList>
          )}

          <div className="mt-3">
            {showAddForm ? (
              <div className="rounded-2xl bg-card border border-border/60 p-4 space-y-3">
                <div className="flex gap-3">
                  <div className="space-y-1.5 flex-1">
                    <Label className="text-xs text-muted-foreground">Label</Label>
                    <Input
                      value={newLabel}
                      onChange={(e) => setNewLabel(e.target.value)}
                      placeholder="e.g. Business Name"
                      className="bg-secondary/40 border-0 focus-visible:ring-1 focus-visible:ring-ring/50"
                    />
                  </div>
                  <div className="space-y-1.5 flex-1">
                    <Label className="text-xs text-muted-foreground">Key</Label>
                    <Input
                      value={newKey}
                      onChange={(e) => setNewKey(e.target.value)}
                      placeholder="e.g. business_name"
                      className="bg-secondary/40 border-0 focus-visible:ring-1 focus-visible:ring-ring/50 font-mono text-sm"
                    />
                  </div>
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
        </>
      )}
    </>
  );
}

// ---- Page ----

export default function SettingsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();
  const { data: settings, isLoading: settingsLoading } = useMySettings();
  const [form, setForm] = useState<Record<string, string>>({});
  const [savedSnapshot, setSavedSnapshot] = useState<Record<string, string>>({});
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | "unsupported">("default");
  const [notifLoading, setNotifLoading] = useState(false);

  useEffect(() => {
    getNotificationPermissionState().then(setNotifPermission);
  }, []);

  useEffect(() => {
    const vals: Record<string, string> = {};
    ALL_FIELDS.forEach(({ key }) => {
      vals[key] = (settings as any)?.[key] ?? "";
    });
    setForm(vals);
    setSavedSnapshot(vals);
  }, [settings]);

  const handleSettingsBlur = async (key: string) => {
    const value = form[key] ?? "";
    if ((savedSnapshot[key] ?? "") === value) return;
    try {
      const { error } = await supabase
        .from("settings")
        .update({ [key]: value } as any)
        .eq("business_id", ADMIN_BUSINESS_ID);
      if (error) throw error;
      setSavedSnapshot((prev) => ({ ...prev, [key]: value }));
      qc.invalidateQueries({ queryKey: ["my_settings"] });
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate("/login");
  };

  return (
    <div className="px-4 md:px-6 pt-8 max-w-2xl mx-auto animate-fade-in">
      <header className="px-1 pb-2">
        <h1 className="font-serif text-3xl text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your personal settings and template variables.
        </p>
      </header>

      <SectionHeader>Appearance</SectionHeader>
      <GroupedList>
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <p className="text-sm text-foreground">Theme</p>
          <ToggleGroup
            type="single"
            value={theme}
            onValueChange={(v) => v && setTheme(v as Theme)}
            className="gap-0 rounded-lg bg-muted p-0.5"
          >
            <ToggleGroupItem value="light" aria-label="Light" className="h-8 px-2.5 rounded-md text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm">
              <Sun className="w-4 h-4" strokeWidth={1.5} />
            </ToggleGroupItem>
            <ToggleGroupItem value="dark" aria-label="Dark" className="h-8 px-2.5 rounded-md text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm">
              <Moon className="w-4 h-4" strokeWidth={1.5} />
            </ToggleGroupItem>
            <ToggleGroupItem value="system" aria-label="System" className="h-8 px-2.5 rounded-md text-muted-foreground data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm">
              <Monitor className="w-4 h-4" strokeWidth={1.5} />
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </GroupedList>

      <SectionHeader>Notifications</SectionHeader>
      <GroupedList>
        <div className="flex items-center justify-between gap-4 px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-foreground">Inbound message alerts</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {notifPermission === "granted"
                ? "Enabled on this device."
                : notifPermission === "denied"
                ? "Blocked — reset site permissions to re-enable."
                : notifPermission === "unsupported"
                ? "Not supported in this browser."
                : "Get notified instantly when a lead replies."}
            </p>
          </div>
          {notifPermission !== "unsupported" && notifPermission !== "denied" && (
            <Button
              size="sm"
              variant={notifPermission === "granted" ? "outline" : "default"}
              disabled={notifLoading}
              onClick={async () => {
                setNotifLoading(true);
                const ok = await requestNotificationPermission(ADMIN_BUSINESS_ID);
                setNotifPermission(ok ? "granted" : Notification.permission);
                if (ok) toast.success(notifPermission === "granted" ? "Subscription refreshed" : "Push notifications enabled");
                else toast.error("Could not enable notifications");
                setNotifLoading(false);
              }}
              className="shrink-0"
            >
              {notifLoading ? (
                <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />
              ) : notifPermission === "granted" ? (
                <><Bell className="w-3.5 h-3.5 mr-1.5" strokeWidth={1.5} /> Refresh</>
              ) : (
                "Enable"
              )}
            </Button>
          )}
        </div>
      </GroupedList>

      {settingsLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        FIELD_GROUPS.map((group) => (
          <div key={group.label}>
            <SectionHeader>{group.label}</SectionHeader>
            <GroupedList>
              {group.fields.map(({ key, label }) => (
                <div key={key} className="px-4 py-3 space-y-1.5">
                  <Label className="text-xs text-muted-foreground">{label}</Label>
                  <Input
                    value={form[key] ?? ""}
                    onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                    onBlur={() => handleSettingsBlur(key)}
                    placeholder={`Enter ${label.toLowerCase()}...`}
                    className="bg-transparent border-0 px-0 h-9 focus-visible:ring-0 focus-visible:ring-offset-0 text-base"
                  />
                </div>
              ))}
            </GroupedList>
          </div>
        ))
      )}

      <OutreachSendingSection />

      <CustomValuesSection />

      <SectionHeader>Account</SectionHeader>
      <GroupedList>
        <button
          onClick={handleSignOut}
          className="flex items-center justify-between gap-4 w-full px-4 py-3.5 hover:bg-secondary/40 transition-colors text-left active-press"
        >
          <span className="text-sm text-foreground">Sign out</span>
          <LogOut className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
        </button>
      </GroupedList>

      <div className="h-12" />
    </div>
  );
}
