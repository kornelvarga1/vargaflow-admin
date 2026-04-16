import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useUpdateContact, SALES_STAGES, ONBOARDING_STAGES, type Contact } from "@/hooks/useContacts";
import { useStopContactSequences } from "@/hooks/useSequences";
import { logActivity } from "@/hooks/useActivityLog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Mail,
  Phone,
  User,
  Building,
  MessageSquare,
  ArrowRightLeft,
  Pause,
  Pencil,
  XCircle,
  Send,
  Clock,
  Zap,
  Activity,
  Loader2,
  Copy,
} from "lucide-react";
import ContactFormDialog from "@/components/contacts/ContactFormDialog";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";

const ALL_STAGES = [
  ...SALES_STAGES.map((s) => ({ ...s, pipeline: "Sales" as const })),
  ...ONBOARDING_STAGES.map((s) => ({ ...s, pipeline: "Onboarding" as const })),
];

function getStageLabel(key: string, pipeline?: string) {
  const match = ALL_STAGES.find((s) => s.key === key && (!pipeline || s.pipeline === pipeline));
  return match?.label || key;
}

// --- Hooks ---

function useContact(id: string) {
  return useQuery({
    queryKey: ["contact", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data as Contact;
    },
  });
}

function useContactActivity(contactId: string) {
  return useQuery({
    queryKey: ["contact_activity", contactId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("activity_log")
        .select("*")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });
}

function useContactMessages(contactId: string) {
  return useQuery({
    queryKey: ["contact_messages", contactId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("message_queue")
        .select("*")
        .eq("contact_id", contactId)
        .order("scheduled_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

function useContactActiveSequences(contactId: string) {
  return useQuery({
    queryKey: ["contact_active_sequences", contactId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contact_sequences")
        .select("*, sequences(name, pipeline, stage)")
        .eq("contact_id", contactId)
        .order("started_at", { ascending: false });
      if (error) throw error;

      // Get step counts
      const seqIds = [...new Set((data || []).map((d: any) => d.sequence_id))];
      const stepCounts: Record<string, number> = {};
      if (seqIds.length > 0) {
        const { data: steps } = await supabase
          .from("sequence_steps")
          .select("sequence_id")
          .in("sequence_id", seqIds);
        if (steps) {
          for (const s of steps) {
            stepCounts[s.sequence_id] = (stepCounts[s.sequence_id] || 0) + 1;
          }
        }
      }

      return (data || []).map((row: any) => ({
        ...row,
        step_count: stepCounts[row.sequence_id] || 0,
      }));
    },
  });
}

// --- Activity icon/color mapping ---

function getActivityIcon(type: string) {
  switch (type) {
    case "stage_changed":
      return <ArrowRightLeft className="w-4 h-4 text-primary" />;
    case "message_sent":
      return <Send className="w-4 h-4 text-primary" />;
    case "contact_created":
      return <User className="w-4 h-4 text-accent-foreground" />;
    case "marked_replied":
      return <MessageSquare className="w-4 h-4 text-primary" />;
    case "sequence_enrolled":
      return <Zap className="w-4 h-4 text-primary" />;
    default:
      return <Activity className="w-4 h-4 text-muted-foreground" />;
  }
}

// --- Main Component ---

export default function ContactProfilePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: contact, isLoading } = useContact(id!);
  const { data: activities = [] } = useContactActivity(id!);
  const { data: messages = [] } = useContactMessages(id!);
  const { data: sequences = [] } = useContactActiveSequences(id!);
  const updateContact = useUpdateContact();
  const stopSequences = useStopContactSequences();
  const qc = useQueryClient();

  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [smsDialogOpen, setSmsDialogOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="p-8 text-center text-muted-foreground">
        Contact not found.
        <Button variant="link" onClick={() => navigate(-1)} className="ml-2">Go back</Button>
      </div>
    );
  }

  const stageLabel = getStageLabel(contact.stage, contact.pipeline);
  const pipelineLabel = contact.pipeline === "Onboarding" ? "Onboarding" : "Sales";
  const activeSeqs = sequences.filter((s: any) => s.status === "active");

  // Merge activities and sent messages into a unified timeline
  const timeline = [
    ...activities.map((a: any) => ({
      id: a.id,
      type: a.activity_type,
      description: a.description,
      timestamp: a.created_at,
      icon: getActivityIcon(a.activity_type),
    })),
    ...messages
      .filter((m: any) => m.status === "sent")
      .map((m: any) => ({
        id: m.id,
        type: "message_sent",
        description: `${m.message_type.toUpperCase()} sent: "${m.message_content.slice(0, 80)}${m.message_content.length > 80 ? "…" : ""}"`,
        timestamp: m.sent_at || m.scheduled_at,
        icon: getActivityIcon("message_sent"),
      })),
  ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const pendingMessages = messages.filter((m: any) => m.status === "pending");

  const handlePauseSequence = async (csId: string) => {
    const { error } = await supabase
      .from("contact_sequences")
      .update({ status: "paused" })
      .eq("id", csId);
    if (error) { toast.error("Failed to pause"); return; }
    qc.invalidateQueries({ queryKey: ["contact_active_sequences"] });
    toast.success("Sequence paused");
  };

  const handleCancelSequence = async (csId: string) => {
    const { error } = await supabase
      .from("contact_sequences")
      .update({ status: "stopped" })
      .eq("id", csId);
    if (error) { toast.error("Failed to cancel"); return; }
    // Cancel messages linked to this specific sequence
    await supabase
      .from("message_queue")
      .update({ status: "cancelled" })
      .eq("contact_sequence_id", csId)
      .eq("status", "pending");
    // Also cancel any pending messages for this contact without a contact_sequence_id
    // (queued by edge functions via queueSteps which don't set contact_sequence_id)
    await supabase
      .from("message_queue")
      .update({ status: "cancelled" })
      .eq("contact_id", contact.id)
      .is("contact_sequence_id", null)
      .eq("status", "pending");
    qc.invalidateQueries({ queryKey: ["contact_active_sequences"] });
    qc.invalidateQueries({ queryKey: ["contact_messages"] });
    toast.success("Sequence cancelled");
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="space-y-1.5">
        {/* Row 1: back + avatar + name + action icons */}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => navigate(-1)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            {(() => {
              const name = contact.full_name.trim();
              const isPhone = !name || /^[+\d]/.test(name);
              return isPhone ? (
                <Phone className="w-4 h-4 text-primary" />
              ) : (
                <span className="text-sm font-display font-bold text-primary">
                  {name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                </span>
              );
            })()}
          </div>
          <h1 className="text-xl font-display font-bold truncate flex-1">{contact.full_name}</h1>
          <Button
            variant="outline"
            size="icon"
            className="shrink-0"
            title="Edit contact"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="shrink-0"
            title="Messages"
            onClick={() => navigate("/messages", { state: { contactId: contact.id } })}
          >
            <MessageSquare className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="shrink-0"
            title="Move Stage"
            onClick={() => setMoveDialogOpen(true)}
          >
            <ArrowRightLeft className="w-4 h-4" />
          </Button>
        </div>
        {/* Row 2: pipeline + stage badges */}
        <div className="flex items-center gap-2 pl-1 flex-wrap">
          <Badge variant="outline" className="border-primary/40 text-primary">
            {pipelineLabel}
          </Badge>
          <Badge variant="secondary">{stageLabel}</Badge>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: info + sequences */}
        <div className="space-y-4">
          {/* Contact Info Card */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-display">Contact Info</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {contact.phone && (
                <div className="flex items-center gap-2">
                  <Phone className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span>{contact.phone}</span>
                </div>
              )}
              {contact.email && (
                <div className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="truncate">{contact.email}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Building className="w-4 h-4 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">{contact.lead_source}</span>
              </div>
              <Separator />
              <div className="text-xs text-muted-foreground">
                Added {formatDistanceToNow(new Date(contact.created_at), { addSuffix: true })}
              </div>
              {contact.notes && (
                <p className="text-xs text-muted-foreground bg-secondary/50 p-2 rounded">{contact.notes}</p>
              )}
            </CardContent>
          </Card>

          {/* Active Sequences Card */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-display flex items-center gap-2">
                <Zap className="w-4 h-4 text-primary" /> Active Sequences
              </CardTitle>
            </CardHeader>
            <CardContent>
              {sequences.length === 0 ? (
                <p className="text-xs text-muted-foreground">No sequences assigned.</p>
              ) : (
                <div className="space-y-3">
                  {sequences.map((seq: any) => (
                    <div key={seq.id} className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium truncate">{seq.sequences?.name || "Unknown"}</p>
                        <Badge
                          variant={
                            seq.status === "active" ? "default" :
                            seq.status === "completed" ? "outline" : "secondary"
                          }
                          className="text-[10px]"
                        >
                          {seq.status}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Step {seq.current_step} of {seq.step_count}
                      </p>
                      {seq.status === "active" && (
                        <div className="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => handlePauseSequence(seq.id)}
                          >
                            <Pause className="w-3 h-3 mr-1" /> Pause
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-destructive"
                            onClick={() => handleCancelSequence(seq.id)}
                          >
                            <XCircle className="w-3 h-3 mr-1" /> Cancel
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Pending Messages */}
          {pendingMessages.length > 0 && (
            <Card className="bg-card border-border">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-display flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted-foreground" /> Pending Messages ({pendingMessages.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {pendingMessages.slice(0, 5).map((msg: any) => (
                  <div key={msg.id} className="text-xs space-y-0.5 p-2 bg-secondary/30 rounded">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className="text-[10px]">{msg.message_type.toUpperCase()}</Badge>
                      <span className="text-muted-foreground">
                        {format(new Date(msg.scheduled_at), "MMM d, h:mm a")}
                      </span>
                    </div>
                    <p className="text-muted-foreground truncate">{msg.message_content}</p>
                  </div>
                ))}
                {pendingMessages.length > 5 && (
                  <p className="text-xs text-muted-foreground text-center">
                    +{pendingMessages.length - 5} more
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column: Activity Timeline */}
        <div className="lg:col-span-2">
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-display flex items-center gap-2">
                <Activity className="w-4 h-4 text-primary" /> Activity Timeline
              </CardTitle>
            </CardHeader>
            <CardContent>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No activity yet.
                </p>
              ) : (
                <div className="relative">
                  {/* Vertical line */}
                  <div className="absolute left-[15px] top-2 bottom-2 w-px bg-border" />

                  <div className="space-y-4">
                    {timeline.map((item) => (
                      <div key={item.id} className="flex gap-3 relative">
                        <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center shrink-0 z-10">
                          {item.icon}
                        </div>
                        <div className="flex-1 min-w-0 pt-1">
                          <p className="text-sm">{item.description}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {format(new Date(item.timestamp), "MMM d, yyyy · h:mm a")}
                            {" · "}
                            {formatDistanceToNow(new Date(item.timestamp), { addSuffix: true })}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Dialogs */}
      <ContactFormDialog
        open={editOpen}
        onOpenChange={(open) => {
          setEditOpen(open);
          if (!open) qc.invalidateQueries({ queryKey: ["contact"] });
        }}
        contact={contact}
      />
      <MoveStageDialog
        open={moveDialogOpen}
        onOpenChange={setMoveDialogOpen}
        contact={contact}
      />
      <SendSmsDialog
        open={smsDialogOpen}
        onOpenChange={setSmsDialogOpen}
        contact={contact}
      />
    </div>
  );
}

// --- Move Stage Dialog ---

const STAGE_FLOW_MAP: Record<string, string> = {
  "No Contact x1 Text": "flow-no-contact-1",
  "No Contact 2x Text": "flow-no-contact-2",
  "No Contact 3x Text": "flow-no-contact-3",
  "No Contact → Long Term Nurture": "flow-long-term-nurture",
  "No Showed to Zoom": "flow-no-show",
  "Cancelled/Rescheduled": "flow-cancelled",
  "Client Closed": "flow-client-closed",
  "New Client Waiting for Onboarding Form": "flow-ob-client-signup",
  "Project Ready to Start": "flow-ob-project-ready",
};

function MoveStageDialog({
  open,
  onOpenChange,
  contact,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  contact: Contact;
}) {
  const updateContact = useUpdateContact();
  const qc = useQueryClient();
  const stages = contact.pipeline === "Onboarding" ? ONBOARDING_STAGES : SALES_STAGES;
  const [selectedStage, setSelectedStage] = useState(contact.stage);

  const handleMove = async () => {
    if (selectedStage === contact.stage) {
      onOpenChange(false);
      return;
    }
    try {
      await updateContact.mutateAsync({
        id: contact.id,
        stage: selectedStage,
        stage_entered_at: new Date().toISOString(),
      });
      const label = stages.find((s) => s.key === selectedStage)?.label || selectedStage;
      await logActivity("stage_changed", `moved to ${label}`, contact.id);
      toast.success(`Moved to ${label}`);

      // Trigger edge function if one exists for this stage
      const flowName = STAGE_FLOW_MAP[selectedStage];
      if (flowName) {
        try {
          await supabase.functions.invoke(flowName, {
            body: { contact_id: contact.id, business_id: contact.business_id },
          });
          toast.info(`Automation triggered: ${flowName}`);
        } catch (err) {
          console.error(`Failed to invoke ${flowName}:`, err);
          toast.error(`Automation failed: ${flowName}`);
        }
      }

      qc.invalidateQueries({ queryKey: ["contact"] });
      qc.invalidateQueries({ queryKey: ["contact_activity"] });
      onOpenChange(false);
    } catch {
      toast.error("Failed to move");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-display">Move to Stage</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <Select value={selectedStage} onValueChange={setSelectedStage}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {stages.map((s) => (
                <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handleMove} disabled={updateContact.isPending}>Move</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- Send SMS Dialog (copy-to-clipboard for now) ---

function SendSmsDialog({
  open,
  onOpenChange,
  contact,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  contact: Contact;
}) {
  const [message, setMessage] = useState("");
  const qc = useQueryClient();

  const handleSend = async () => {
    if (!message.trim()) {
      toast.error("Message is required");
      return;
    }

    // Queue the message and copy to clipboard
    const { error } = await supabase.from("message_queue").insert({
      contact_id: contact.id,
      message_content: message,
      message_type: "sms",
      scheduled_at: new Date().toISOString(),
      status: "pending",
      to_phone: contact.phone,
      business_id: contact.business_id,
      metadata: { to: contact.phone },
    });

    if (error) {
      toast.error("Failed to queue message");
      return;
    }

    await navigator.clipboard.writeText(message);
    await logActivity("message_queued", `Manual SMS queued: "${message.slice(0, 60)}…"`, contact.id);
    qc.invalidateQueries({ queryKey: ["contact_messages"] });
    qc.invalidateQueries({ queryKey: ["contact_activity"] });
    toast.success("Message queued & copied to clipboard", {
      description: contact.phone ? `Send to ${contact.phone}` : "No phone number on file",
    });
    setMessage("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-display">Send SMS to {contact.full_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {contact.phone && (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Phone className="w-4 h-4" /> {contact.phone}
            </p>
          )}
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Type your message..."
            rows={4}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={handleSend}>
              <Copy className="w-4 h-4 mr-1" /> Queue & Copy
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
