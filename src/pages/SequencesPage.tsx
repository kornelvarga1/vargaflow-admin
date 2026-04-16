import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Pause, XCircle, Zap, Activity, ChevronDown, ChevronRight, Check, ListChecks, Users } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

// ---- Active Automations (existing) ----

type ContactSequenceRow = {
  id: string;
  contact_id: string;
  sequence_id: string;
  status: string;
  current_step: number;
  next_fire_at: string | null;
  started_at: string;
  contacts: { full_name: string } | null;
  sequences: { name: string; pipeline: string; stage: string } | null;
  step_count: number;
};

function useContactSequences(statusFilter: string) {
  return useQuery({
    queryKey: ["contact_sequences_monitor", statusFilter],
    queryFn: async () => {
      let query = supabase
        .from("contact_sequences")
        .select("*, contacts(full_name), sequences(name, pipeline, stage)")
        .order("updated_at", { ascending: false });

      if (statusFilter && statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }

      const { data, error } = await query;
      if (error) throw error;

      const sequenceIds = [...new Set((data || []).map((d: any) => d.sequence_id))];
      const stepCounts: Record<string, number> = {};

      if (sequenceIds.length > 0) {
        const { data: steps } = await supabase
          .from("sequence_steps")
          .select("sequence_id")
          .in("sequence_id", sequenceIds);

        if (steps) {
          for (const step of steps) {
            stepCounts[step.sequence_id] = (stepCounts[step.sequence_id] || 0) + 1;
          }
        }
      }

      return (data || []).map((row: any) => ({
        ...row,
        step_count: stepCounts[row.sequence_id] || 0,
      })) as ContactSequenceRow[];
    },
    refetchInterval: 30000,
  });
}

function useNextScheduledMessages(contactSequenceIds: string[]) {
  return useQuery({
    queryKey: ["next_messages", contactSequenceIds],
    enabled: contactSequenceIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("message_queue")
        .select("contact_sequence_id, scheduled_at")
        .in("contact_sequence_id", contactSequenceIds)
        .eq("status", "pending")
        .order("scheduled_at", { ascending: true });

      if (error) throw error;

      const map: Record<string, string> = {};
      for (const row of data || []) {
        if (row.contact_sequence_id && !map[row.contact_sequence_id]) {
          map[row.contact_sequence_id] = row.scheduled_at;
        }
      }
      return map;
    },
  });
}

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  active: { label: "Active", variant: "default" },
  paused: { label: "Paused", variant: "secondary" },
  completed: { label: "Completed", variant: "outline" },
  stopped: { label: "Cancelled", variant: "destructive" },
  failed: { label: "Failed", variant: "destructive" },
};

function ActiveAutomationsTab() {
  const [filter, setFilter] = useState("all");
  const { data: rows = [], isLoading } = useContactSequences(filter);
  const qc = useQueryClient();

  const csIds = rows.map((r) => r.id);
  const { data: nextMessages = {} } = useNextScheduledMessages(csIds);

  const pauseMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("contact_sequences")
        .update({ status: "paused" })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact_sequences_monitor"] });
      toast.success("Automation paused");
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (row: ContactSequenceRow) => {
      const { error } = await supabase
        .from("contact_sequences")
        .update({ status: "stopped" })
        .eq("id", row.id);
      if (error) throw error;
      await supabase
        .from("message_queue")
        .update({ status: "cancelled" })
        .eq("contact_sequence_id", row.id)
        .eq("status", "pending");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact_sequences_monitor"] });
      qc.invalidateQueries({ queryKey: ["next_messages"] });
      toast.success("Automation cancelled");
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="paused">Paused</SelectItem>
            <SelectItem value="completed">Completed</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-12 text-center">
            <Zap className="w-10 h-10 mx-auto mb-3 text-muted-foreground/40" />
            <p className="text-muted-foreground">
              No active automations. Automations will appear here automatically when contacts enter a pipeline stage.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="bg-card border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Contact</TableHead>
                <TableHead>Flow</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Next Message</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const sc = statusConfig[row.status] || statusConfig.active;
                const nextAt = nextMessages[row.id];
                return (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">
                      {row.contacts?.full_name || "Unknown"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.sequences?.name || "Unknown flow"}
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">
                        Step {row.current_step} of {row.step_count}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {row.status === "active" && nextAt
                        ? format(new Date(nextAt), "MMM d, h:mm a")
                        : "—"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={sc.variant}>{sc.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {row.status === "active" && (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            title="Pause"
                            onClick={() => pauseMutation.mutate(row.id)}
                            disabled={pauseMutation.isPending}
                          >
                            <Pause className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 text-destructive"
                            title="Cancel"
                            onClick={() => cancelMutation.mutate(row)}
                            disabled={cancelMutation.isPending}
                          >
                            <XCircle className="w-4 h-4" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

// ---- Sequence Templates Tab ----

type Sequence = {
  id: string;
  name: string;
  pipeline: string;
  stage: string;
  is_active: boolean;
};

type SequenceStep = {
  id: string;
  sequence_id: string;
  step_order: number;
  message_type: string;
  delay_hours: number;
  delay_minutes: number;
  message_template: string;
};

function useSequences() {
  return useQuery({
    queryKey: ["sequences_templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sequences")
        .select("*")
        .order("name");
      if (error) throw error;
      return data as Sequence[];
    },
  });
}

function useSequenceSteps(sequenceId: string) {
  return useQuery({
    queryKey: ["sequence_steps_templates", sequenceId],
    enabled: !!sequenceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sequence_steps")
        .select("*")
        .eq("sequence_id", sequenceId)
        .order("step_order");
      if (error) throw error;
      return data as SequenceStep[];
    },
  });
}

function StepRow({ step }: { step: SequenceStep }) {
  const qc = useQueryClient();
  const [content, setContent] = useState(step.message_template);
  const isDirty = content !== step.message_template;

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("sequence_steps")
        .update({ message_template: content })
        .eq("id", step.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sequence_steps_templates", step.sequence_id] });
      toast.success("Step saved");
    },
    onError: () => toast.error("Failed to save step"),
  });

  const delayLabel =
    step.delay_hours > 0 && step.delay_minutes > 0
      ? `+${step.delay_hours}h ${step.delay_minutes}m`
      : step.delay_hours > 0
      ? `+${step.delay_hours}h`
      : step.delay_minutes > 0
      ? `+${step.delay_minutes}m`
      : "Immediate";

  return (
    <div className="border border-border rounded-lg p-3 space-y-2 bg-secondary/20">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono text-muted-foreground w-8">#{step.step_order}</span>
        <Badge
          variant={step.message_type === "sms" ? "default" : "secondary"}
          className="text-[10px] uppercase tracking-wide"
        >
          {step.message_type}
        </Badge>
        <span className="text-xs text-muted-foreground">{delayLabel}</span>
      </div>
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        className="bg-background border-border text-sm font-mono resize-none"
      />
      {isDirty && (
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="gradient-primary text-primary-foreground h-7 text-xs"
        >
          {saveMutation.isPending ? (
            <Loader2 className="w-3 h-3 mr-1 animate-spin" />
          ) : (
            <Check className="w-3 h-3 mr-1" />
          )}
          Save
        </Button>
      )}
    </div>
  );
}

function SequenceCard({ seq }: { seq: Sequence }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const { data: steps, isLoading: stepsLoading } = useSequenceSteps(expanded ? seq.id : "");

  const toggleActive = useMutation({
    mutationFn: async (val: boolean) => {
      const { error } = await supabase
        .from("sequences")
        .update({ is_active: val })
        .eq("id", seq.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sequences_templates"] });
    },
    onError: () => toast.error("Failed to update"),
  });

  return (
    <Card className="bg-card border-border shadow-card">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-secondary/40 transition-colors rounded-t-lg"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{seq.name}</p>
          <p className="text-xs text-muted-foreground">
            {seq.pipeline} · {seq.stage}
          </p>
        </div>
        <div
          className="flex items-center gap-2"
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-xs text-muted-foreground">
            {seq.is_active ? "Active" : "Inactive"}
          </span>
          <Switch
            checked={seq.is_active}
            onCheckedChange={(val) => toggleActive.mutate(val)}
            disabled={toggleActive.isPending}
          />
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-2 border-t border-border pt-3">
          {stepsLoading ? (
            <div className="flex justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : !steps || steps.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No steps defined.</p>
          ) : (
            steps.map((step) => <StepRow key={step.id} step={step} />)
          )}
        </div>
      )}
    </Card>
  );
}

function SequenceTemplatesTab() {
  const { data: sequences, isLoading } = useSequences();

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!sequences || sequences.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-12 text-center">
          <ListChecks className="w-10 h-10 mx-auto mb-3 text-muted-foreground/40" />
          <p className="text-muted-foreground">No sequences found.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {sequences.map((seq) => (
        <SequenceCard key={seq.id} seq={seq} />
      ))}
    </div>
  );
}

// ---- Client Sequence Templates Tab ----

type ClientTemplate = {
  id: string;
  flow_name: string;
  step_name: string;
  message_type: string;
  subject: string | null;
  content: string;
  delay_seconds: number;
  business_id: string | null;
};

const FLOW_LABELS: Record<string, string> = {
  "missed-call-text-back": "Missed Call Text-Back",
  "form-submission-confirmation": "Form Submission",
  "db-reactivation": "Database Reactivation",
  "review-request-sequence": "Review Request",
  "one-year-referral-sequence": "1-Year Referral",
  "chat-widget-lead": "Chat Widget Lead",
  "fb-message-confirmation": "Facebook Message",
  "ig-message-confirmation": "Instagram Message",
};

const STEP_LABELS: Record<string, string> = {
  sms1: "SMS 1", sms2: "SMS 2", sms3: "SMS 3", sms4: "SMS 4", sms5: "SMS 5",
  sms_initial: "SMS (Initial)", sms_followup: "SMS (Follow-up)",
  email_initial: "Email (Initial)",
  fb_reply: "FB Reply", ig_reply: "IG Reply",
};

function useClientTemplates(businessId?: string | null) {
  return useQuery({
    queryKey: ["client_templates", businessId ?? "global"],
    queryFn: async () => {
      let query = (supabase as any)
        .from("client_sequence_templates")
        .select("*")
        .order("flow_name")
        .order("step_name");

      if (businessId) {
        query = query.eq("business_id", businessId);
      } else {
        query = query.is("business_id", null);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as ClientTemplate[];
    },
  });
}

function ClientStepRow({
  tpl,
  businessId,
  globalContent,
}: {
  tpl: ClientTemplate;
  businessId?: string | null;
  globalContent?: string;
}) {
  const qc = useQueryClient();
  const [content, setContent] = useState(tpl.content);
  const isDirty = content !== tpl.content;
  const isOverride = !!tpl.business_id;

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (isOverride) {
        const { error } = await (supabase as any)
          .from("client_sequence_templates")
          .update({ content })
          .eq("id", tpl.id);
        if (error) throw error;
      } else {
        const { error } = await (supabase as any)
          .from("client_sequence_templates")
          .update({ content })
          .eq("flow_name", tpl.flow_name)
          .eq("step_name", tpl.step_name)
          .is("business_id", null);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client_templates"] });
      toast.success("Template saved");
    },
    onError: () => toast.error("Failed to save"),
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const { error } = await (supabase as any)
        .from("client_sequence_templates")
        .delete()
        .eq("id", tpl.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client_templates"] });
      toast.success("Override removed — using global template");
    },
    onError: () => toast.error("Failed to reset"),
  });

  const delayLabel = tpl.delay_seconds > 0
    ? tpl.delay_seconds >= 3600
      ? `+${Math.round(tpl.delay_seconds / 3600)}h`
      : `+${tpl.delay_seconds}s`
    : "Immediate";

  return (
    <div className="border border-border rounded-lg p-3 space-y-2 bg-secondary/20">
      <div className="flex items-center gap-2 flex-wrap justify-between">
        <div className="flex items-center gap-2">
          <Badge variant={tpl.message_type === "sms" ? "default" : "secondary"} className="text-[10px] uppercase tracking-wide">
            {tpl.message_type}
          </Badge>
          <span className="text-xs font-medium">{STEP_LABELS[tpl.step_name] ?? tpl.step_name}</span>
          {tpl.delay_seconds > 0 && (
            <span className="text-xs text-muted-foreground">{delayLabel}</span>
          )}
        </div>
        {isOverride && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs text-muted-foreground"
            onClick={() => resetMutation.mutate()}
            disabled={resetMutation.isPending}
          >
            Reset to global
          </Button>
        )}
      </div>
      {globalContent && isOverride && (
        <p className="text-[11px] text-muted-foreground italic border-l-2 border-border pl-2">
          Global: {globalContent.slice(0, 80)}{globalContent.length > 80 ? "…" : ""}
        </p>
      )}
      <Textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        className="bg-background border-border text-sm font-mono resize-none"
      />
      <p className="text-[10px] text-muted-foreground">
        Variables: <code className="font-mono">{"{{first_name}} {{my_name}} {{company_name}} {{my_phone}} {{quote_form_link}} {{website_url}} {{review_link}} {{discount_amount}} {{reactivation_offer}}"}</code>
      </p>
      {isDirty && (
        <Button
          size="sm"
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="gradient-primary text-primary-foreground h-7 text-xs"
        >
          {saveMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Check className="w-3 h-3 mr-1" />}
          Save
        </Button>
      )}
    </div>
  );
}

function ClientFlowCard({
  flowName,
  templates,
  businessId,
  globalTemplates,
}: {
  flowName: string;
  templates: ClientTemplate[];
  businessId?: string | null;
  globalTemplates?: ClientTemplate[];
}) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const hasOverrides = templates.some((t) => t.business_id === businessId);

  // For business view: allow adding override for a step that has none
  const globalSteps = globalTemplates?.filter((t) => t.flow_name === flowName) ?? [];
  const overriddenSteps = new Set(templates.map((t) => t.step_name));
  const missingOverrides = businessId ? globalSteps.filter((t) => !overriddenSteps.has(t.step_name)) : [];

  const addOverride = useMutation({
    mutationFn: async (globalTpl: ClientTemplate) => {
      const { error } = await (supabase as any)
        .from("client_sequence_templates")
        .insert({
          flow_name: globalTpl.flow_name,
          step_name: globalTpl.step_name,
          message_type: globalTpl.message_type,
          subject: globalTpl.subject,
          content: globalTpl.content,
          delay_seconds: globalTpl.delay_seconds,
          business_id: businessId,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client_templates"] });
      toast.success("Override created");
    },
    onError: () => toast.error("Failed to create override"),
  });

  return (
    <Card className="bg-card border-border shadow-card">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-secondary/40 transition-colors rounded-t-lg"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{FLOW_LABELS[flowName] ?? flowName}</p>
          <p className="text-xs text-muted-foreground font-mono">{flowName}</p>
        </div>
        {businessId && hasOverrides && (
          <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">
            {templates.length} override{templates.length !== 1 ? "s" : ""}
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">{(businessId ? templates : globalSteps.length > 0 ? globalSteps : templates).length} steps</span>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-2 border-t border-border pt-3">
          {templates.map((tpl) => (
            <ClientStepRow
              key={tpl.id}
              tpl={tpl}
              businessId={businessId}
              globalContent={businessId ? globalTemplates?.find((g) => g.flow_name === flowName && g.step_name === tpl.step_name)?.content : undefined}
            />
          ))}
          {missingOverrides.map((globalTpl) => (
            <div key={globalTpl.step_name} className="border border-dashed border-border rounded-lg p-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="text-[10px] uppercase">{globalTpl.message_type}</Badge>
                <span className="text-xs text-muted-foreground">{STEP_LABELS[globalTpl.step_name] ?? globalTpl.step_name}</span>
                <span className="text-xs text-muted-foreground/60 italic">Using global</span>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                onClick={() => addOverride.mutate(globalTpl)}
                disabled={addOverride.isPending}
              >
                Override
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export function ClientSequencesTab({ businessId }: { businessId?: string | null }) {
  const { data: templates, isLoading } = useClientTemplates(businessId);
  const { data: globalTemplates } = useClientTemplates(null);

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Group templates by flow_name
  const displayTemplates = businessId
    ? (templates ?? [])
    : (templates ?? []);

  const allFlowNames = businessId
    ? [...new Set([...(globalTemplates ?? []).map((t) => t.flow_name), ...(templates ?? []).map((t) => t.flow_name)])]
    : [...new Set((templates ?? []).map((t) => t.flow_name))];

  if (allFlowNames.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-12 text-center">
          <Users className="w-10 h-10 mx-auto mb-3 text-muted-foreground/40" />
          <p className="text-muted-foreground text-sm">No client sequence templates found.</p>
          <p className="text-xs text-muted-foreground mt-1">Run the SQL migration to seed the default templates.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {allFlowNames.map((flowName) => {
        const flowTemplates = businessId
          ? (templates ?? []).filter((t) => t.flow_name === flowName)
          : (templates ?? []).filter((t) => t.flow_name === flowName);
        return (
          <ClientFlowCard
            key={flowName}
            flowName={flowName}
            templates={flowTemplates}
            businessId={businessId}
            globalTemplates={globalTemplates}
          />
        );
      })}
    </div>
  );
}

// ---- Page ----

export default function SequencesPage() {
  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-display font-bold flex items-center gap-2">
          <Activity className="w-6 h-6 text-primary" />
          Sequences
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Monitor active automations and manage sequence templates.
        </p>
      </div>

      <Tabs defaultValue="active">
        <TabsList className="mb-4">
          <TabsTrigger value="active">Active Automations</TabsTrigger>
          <TabsTrigger value="templates">My Sequences</TabsTrigger>
          <TabsTrigger value="client_sequences">Client Sequences</TabsTrigger>
        </TabsList>

        <TabsContent value="active">
          <ActiveAutomationsTab />
        </TabsContent>

        <TabsContent value="templates">
          <SequenceTemplatesTab />
        </TabsContent>

        <TabsContent value="client_sequences">
          <ClientSequencesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
