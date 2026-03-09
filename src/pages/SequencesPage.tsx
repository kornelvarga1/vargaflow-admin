import { useState } from "react";
import {
  useSequences,
  useSequenceSteps,
  useCreateSequence,
  useUpdateSequence,
  useDeleteSequence,
  useCreateStep,
  useUpdateStep,
  useDeleteStep,
  type Sequence,
  type SequenceStep,
} from "@/hooks/useSequences";
import { SALES_STAGES, ONBOARDING_STAGES } from "@/hooks/useContacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Plus,
  Trash2,
  Pencil,
  ChevronRight,
  ArrowLeft,
  Zap,
  Clock,
  MessageSquare,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";

const ALL_STAGES = [
  ...SALES_STAGES.map((s) => ({ ...s, pipeline: "sales" })),
  ...ONBOARDING_STAGES.map((s) => ({ ...s, pipeline: "onboarding" })),
];

export default function SequencesPage() {
  const { data: sequences = [], isLoading } = useSequences();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSeq, setEditingSeq] = useState<Sequence | null>(null);

  if (selectedId) {
    return (
      <SequenceDetail
        sequenceId={selectedId}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-display font-bold">Sequences</h1>
          <p className="text-sm text-muted-foreground">
            Automated message sequences triggered by pipeline stage changes
          </p>
        </div>
        <Button onClick={() => { setEditingSeq(null); setDialogOpen(true); }}>
          <Plus className="w-4 h-4 mr-1" /> New Sequence
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : sequences.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-8 text-center text-muted-foreground">
            No sequences yet. Create one to start automating your outreach.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sequences.map((seq) => {
            const stageInfo = ALL_STAGES.find(
              (s) => s.key === seq.stage && s.pipeline === seq.pipeline
            );
            return (
              <Card
                key={seq.id}
                className="bg-card border-border hover:border-accent/40 transition-colors cursor-pointer"
                onClick={() => setSelectedId(seq.id)}
              >
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-accent flex items-center justify-center shrink-0">
                    <Zap className="w-5 h-5 text-accent-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-display font-semibold truncate">{seq.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Triggers on{" "}
                      <span className="text-accent-foreground">{stageInfo?.label || seq.stage}</span>
                      {" · "}
                      <span className="capitalize">{seq.pipeline}</span> pipeline
                    </p>
                  </div>
                  <Badge variant={seq.is_active ? "default" : "secondary"} className="shrink-0">
                    {seq.is_active ? "Active" : "Paused"}
                  </Badge>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <SequenceFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        sequence={editingSeq}
      />
    </div>
  );
}

// --- Sequence Form Dialog ---
function SequenceFormDialog({
  open,
  onOpenChange,
  sequence,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sequence: Sequence | null;
}) {
  const create = useCreateSequence();
  const update = useUpdateSequence();
  const isEdit = !!sequence;

  const [name, setName] = useState(sequence?.name || "");
  const [pipeline, setPipeline] = useState(sequence?.pipeline || "sales");
  const [stage, setStage] = useState(sequence?.stage || "lead_in");

  const stages = pipeline === "onboarding" ? ONBOARDING_STAGES : SALES_STAGES;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { toast.error("Name is required"); return; }
    try {
      if (isEdit) {
        await update.mutateAsync({ id: sequence.id, name, pipeline, stage });
      } else {
        await create.mutateAsync({ name, pipeline, stage });
      }
      toast.success(isEdit ? "Sequence updated" : "Sequence created");
      onOpenChange(false);
    } catch {
      toast.error("Something went wrong");
    }
  };

  // Reset form when dialog opens
  const handleOpenChange = (o: boolean) => {
    if (o && !sequence) { setName(""); setPipeline("sales"); setStage("lead_in"); }
    if (o && sequence) { setName(sequence.name); setPipeline(sequence.pipeline); setStage(sequence.stage); }
    onOpenChange(o);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-display">{isEdit ? "Edit Sequence" : "New Sequence"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. New Lead Follow-Up" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Pipeline</Label>
              <Select value={pipeline} onValueChange={(v) => { setPipeline(v); setStage(v === "onboarding" ? "intake" : "lead_in"); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sales">Sales</SelectItem>
                  <SelectItem value="onboarding">Onboarding</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Trigger Stage</Label>
              <Select value={stage} onValueChange={setStage}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || update.isPending}>
              {isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- Sequence Detail (steps) ---
function SequenceDetail({ sequenceId, onBack }: { sequenceId: string; onBack: () => void }) {
  const { data: sequences = [] } = useSequences();
  const sequence = sequences.find((s) => s.id === sequenceId);
  const { data: steps = [], isLoading } = useSequenceSteps(sequenceId);
  const createStep = useCreateStep();
  const updateStep = useUpdateStep();
  const deleteStep = useDeleteStep();
  const updateSeq = useUpdateSequence();
  const deleteSeq = useDeleteSequence();

  const [stepDialogOpen, setStepDialogOpen] = useState(false);
  const [editingStep, setEditingStep] = useState<SequenceStep | null>(null);

  if (!sequence) return null;

  const handleDeleteSequence = async () => {
    try {
      await deleteSeq.mutateAsync(sequenceId);
      toast.success("Sequence deleted");
      onBack();
    } catch {
      toast.error("Failed to delete");
    }
  };

  const handleToggle = async (active: boolean) => {
    await updateSeq.mutateAsync({ id: sequenceId, is_active: active });
    toast.success(active ? "Sequence activated" : "Sequence paused");
  };

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-display font-bold">{sequence.name}</h1>
          <p className="text-sm text-muted-foreground">
            Triggers when contact enters{" "}
            <span className="text-accent-foreground">
              {ALL_STAGES.find((s) => s.key === sequence.stage && s.pipeline === sequence.pipeline)?.label || sequence.stage}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground">Active</Label>
            <Switch checked={sequence.is_active} onCheckedChange={handleToggle} />
          </div>
          <Button variant="ghost" size="icon" className="text-destructive" onClick={handleDeleteSequence}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <Separator />

      <div className="flex items-center justify-between">
        <h2 className="text-lg font-display font-semibold">Steps</h2>
        <Button size="sm" onClick={() => { setEditingStep(null); setStepDialogOpen(true); }}>
          <Plus className="w-4 h-4 mr-1" /> Add Step
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : steps.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-6 text-center text-muted-foreground text-sm">
            No steps yet. Add steps to define the messages in this sequence.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {steps.map((step, idx) => (
            <Card key={step.id} className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center shrink-0 mt-0.5">
                    <span className="text-xs font-display font-bold text-muted-foreground">{idx + 1}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="text-[10px] border-accent/40 text-accent-foreground">
                        <MessageSquare className="w-3 h-3 mr-1" />
                        {step.message_type.toUpperCase()}
                      </Badge>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {step.delay_hours > 0 && `${step.delay_hours}h`}
                        {step.delay_minutes > 0 && ` ${step.delay_minutes}m`}
                        {step.delay_hours === 0 && step.delay_minutes === 0 && "Immediately"}
                        {" after enrollment"}
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap">{step.message_template}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => { setEditingStep(step); setStepDialogOpen(true); }}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      onClick={async () => {
                        await deleteStep.mutateAsync({ id: step.id, sequence_id: sequenceId });
                        toast.success("Step deleted");
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <StepFormDialog
        open={stepDialogOpen}
        onOpenChange={setStepDialogOpen}
        sequenceId={sequenceId}
        step={editingStep}
        nextOrder={steps.length + 1}
      />
    </div>
  );
}

// --- Step Form Dialog ---
function StepFormDialog({
  open,
  onOpenChange,
  sequenceId,
  step,
  nextOrder,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  sequenceId: string;
  step: SequenceStep | null;
  nextOrder: number;
}) {
  const create = useCreateStep();
  const update = useUpdateStep();
  const isEdit = !!step;

  const [template, setTemplate] = useState(step?.message_template || "");
  const [type, setType] = useState(step?.message_type || "sms");
  const [hours, setHours] = useState(step?.delay_hours?.toString() || "0");
  const [minutes, setMinutes] = useState(step?.delay_minutes?.toString() || "0");

  const handleOpenChange = (o: boolean) => {
    if (o && !step) { setTemplate(""); setType("sms"); setHours("0"); setMinutes("0"); }
    if (o && step) { setTemplate(step.message_template); setType(step.message_type); setHours(String(step.delay_hours)); setMinutes(String(step.delay_minutes)); }
    onOpenChange(o);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!template.trim()) { toast.error("Message is required"); return; }
    try {
      if (isEdit) {
        await update.mutateAsync({
          id: step.id,
          sequence_id: sequenceId,
          message_template: template,
          message_type: type,
          delay_hours: parseInt(hours) || 0,
          delay_minutes: parseInt(minutes) || 0,
        });
      } else {
        await create.mutateAsync({
          sequence_id: sequenceId,
          step_order: nextOrder,
          message_template: template,
          message_type: type,
          delay_hours: parseInt(hours) || 0,
          delay_minutes: parseInt(minutes) || 0,
        });
      }
      toast.success(isEdit ? "Step updated" : "Step added");
      onOpenChange(false);
    } catch {
      toast.error("Something went wrong");
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-display">{isEdit ? "Edit Step" : "Add Step"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="sms">SMS</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Delay (hours)</Label>
              <Input type="number" min="0" value={hours} onChange={(e) => setHours(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Delay (minutes)</Label>
              <Input type="number" min="0" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>
              Message Template
              <span className="text-xs text-muted-foreground ml-2">
                Use {"{{variable}}"} for custom values
              </span>
            </Label>
            <Textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="Hi {{contact_name}}, thanks for your interest in {{company_name}}..."
              rows={5}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={create.isPending || update.isPending}>
              {isEdit ? "Save" : "Add Step"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
