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
import { Loader2, Pause, XCircle, Zap, Activity, ChevronDown, ChevronRight, Check, ListChecks } from "lucide-react";
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
      let stepCounts: Record<string, number> = {};

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
          <TabsTrigger value="templates">Sequence Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="active">
          <ActiveAutomationsTab />
        </TabsContent>

        <TabsContent value="templates">
          <SequenceTemplatesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
