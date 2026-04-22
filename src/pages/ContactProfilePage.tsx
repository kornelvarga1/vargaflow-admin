import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { invokeFunction } from "@/lib/invokeFunction";
import { ADMIN_BUSINESS_ID } from "@/lib/constants";
import { useUpdateContact, SALES_STAGES, ONBOARDING_STAGES, type Contact } from "@/hooks/useContacts";
import { logActivity } from "@/hooks/useActivityLog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Phone,
  User,
  MessageSquare,
  ArrowRightLeft,
  Pause,
  Pencil,
  XCircle,
  Send,
  Zap,
  Activity,
  Loader2,
  Copy,
} from "lucide-react";
import ContactFormDialog from "@/components/contacts/ContactFormDialog";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { getInitials, getAvatarTone } from "@/lib/initials";

const ALL_STAGES = [
  ...SALES_STAGES.map((s) => ({ ...s, pipeline: "Sales" as const })),
  ...ONBOARDING_STAGES.map((s) => ({ ...s, pipeline: "Onboarding" as const })),
];

function getStageLabel(key: string, pipeline?: string) {
  const match = ALL_STAGES.find((s) => s.key === key && (!pipeline || s.pipeline === pipeline));
  return match?.label || key;
}

function formatActivityTime(iso: string): { display: string; full: string } {
  const date = new Date(iso);
  const ageDays = (Date.now() - date.getTime()) / 86_400_000;
  const display =
    ageDays < 7
      ? formatDistanceToNow(date, { addSuffix: true })
      : format(date, "MMM d");
  const full = format(date, "MMM d, yyyy · h:mm a");
  return { display, full };
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

// --- Activity icon mapping ---

function getActivityIcon(type: string) {
  const cls = "w-4 h-4 text-muted-foreground";
  switch (type) {
    case "stage_changed":
      return <ArrowRightLeft className={cls} strokeWidth={1.5} />;
    case "message_sent":
      return <Send className={cls} strokeWidth={1.5} />;
    case "contact_created":
      return <User className={cls} strokeWidth={1.5} />;
    case "marked_replied":
      return <MessageSquare className={cls} strokeWidth={1.5} />;
    case "sequence_enrolled":
      return <Zap className={cls} strokeWidth={1.5} />;
    default:
      return <Activity className={cls} strokeWidth={1.5} />;
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
  const heroName = contact.full_name.trim();
  const heroIsPhone = !heroName || /^[+\d]/.test(heroName);
  const heroMeta: string[] = [];
  if (contact.phone) heroMeta.push(contact.phone);
  if (contact.email) heroMeta.push(contact.email);
  if (contact.lead_source) heroMeta.push(contact.lead_source);

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
    await supabase
      .from("message_queue")
      .update({ status: "cancelled" })
      .eq("contact_sequence_id", csId)
      .eq("status", "pending");
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
    <div className="px-4 md:px-6 pt-4 max-w-2xl mx-auto animate-fade-in">
      {/* Top action row */}
      <div className="flex items-center justify-between -mx-1">
        <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => navigate(-1)}>
          <ArrowLeft className="w-5 h-5" strokeWidth={1.5} />
        </Button>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground" title="Edit contact" onClick={() => setEditOpen(true)}>
            <Pencil className="w-4 h-4" strokeWidth={1.5} />
          </Button>
          <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground" title="Messages" onClick={() => navigate("/messages", { state: { contactId: contact.id } })}>
            <MessageSquare className="w-4 h-4" strokeWidth={1.5} />
          </Button>
          <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground" title="Move stage" onClick={() => setMoveDialogOpen(true)}>
            <ArrowRightLeft className="w-4 h-4" strokeWidth={1.5} />
          </Button>
        </div>
      </div>

      {/* Hero — avatar + serif name + muted metadata + pipeline/stage badges */}
      <header className="px-1 pt-6 pb-8">
        <div className={`w-20 h-20 rounded-full ${heroIsPhone ? "bg-secondary" : getAvatarTone(heroName)} flex items-center justify-center mb-5`}>
          {heroIsPhone ? (
            <Phone className="w-7 h-7 text-muted-foreground" strokeWidth={1.5} />
          ) : (
            <span className="text-2xl font-medium text-white/95">
              {getInitials(heroName)}
            </span>
          )}
        </div>
        <h1 className="font-serif text-3xl text-foreground leading-tight">{contact.full_name}</h1>
        {heroMeta.length > 0 && (
          <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
            {heroMeta.join(" · ")}
          </p>
        )}
        <p
          className="text-xs text-muted-foreground/80 mt-1.5"
          title={format(new Date(contact.created_at), "MMM d, yyyy · h:mm a")}
        >
          Added {formatDistanceToNow(new Date(contact.created_at), { addSuffix: true })}
        </p>
        <div className="flex items-center gap-2 flex-wrap mt-4">
          <Badge variant="outline" className="text-xs border-border/60 text-muted-foreground font-normal">{pipelineLabel}</Badge>
          <Badge variant="outline" className="text-xs border-border/60 text-muted-foreground font-normal">{stageLabel}</Badge>
        </div>
      </header>

      {/* Notes — whole card tappable */}
      <button
        onClick={() => setEditOpen(true)}
        className="w-full text-left bg-card border border-border/60 rounded-2xl p-4 hover:bg-secondary/30 transition-colors active-press"
      >
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2">Notes</p>
        {contact.notes ? (
          <p className="text-sm text-foreground/90 whitespace-pre-wrap leading-relaxed">{contact.notes}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Add a note…</p>
        )}
      </button>

      {/* Active Sequences */}
      {sequences.length > 0 && (
        <section className="mt-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground px-1 mb-3">
            Active Sequences
          </p>
          <ul className="bg-card border border-border/60 rounded-2xl divide-y divide-border/40 overflow-hidden">
            {sequences.map((seq: any) => (
              <li key={seq.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-foreground truncate">{seq.sequences?.name || "Unknown"}</p>
                  <Badge variant="outline" className="text-[10px] border-border/60 text-muted-foreground font-normal shrink-0">
                    {seq.status}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Step {seq.current_step} of {seq.step_count}
                </p>
                {seq.status === "active" && (
                  <div className="flex gap-1 mt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => handlePauseSequence(seq.id)}
                    >
                      <Pause className="w-3 h-3 mr-1" strokeWidth={1.5} /> Pause
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-destructive hover:text-destructive"
                      onClick={() => handleCancelSequence(seq.id)}
                    >
                      <XCircle className="w-3 h-3 mr-1" strokeWidth={1.5} /> Cancel
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Pending Messages */}
      {pendingMessages.length > 0 && (
        <section className="mt-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground px-1 mb-3">
            Pending ({pendingMessages.length})
          </p>
          <div className="bg-card border border-border/60 rounded-2xl p-4 space-y-2">
            {pendingMessages.slice(0, 5).map((msg: any) => (
              <div key={msg.id} className="text-xs space-y-1 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="outline" className="text-[10px] border-border/60 text-muted-foreground font-normal">
                    {msg.message_type.toUpperCase()}
                  </Badge>
                  <span className="text-muted-foreground">
                    {format(new Date(msg.scheduled_at), "MMM d, h:mm a")}
                  </span>
                </div>
                <p className="text-muted-foreground truncate">{msg.message_content}</p>
              </div>
            ))}
            {pendingMessages.length > 5 && (
              <p className="text-xs text-muted-foreground text-center pt-1">
                +{pendingMessages.length - 5} more
              </p>
            )}
          </div>
        </section>
      )}

      {/* Activity Timeline */}
      <section className="mt-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground px-1 mb-4">
          Activity
        </p>
        {timeline.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No activity yet.
          </p>
        ) : (
          <div className="relative pl-1">
            <div className="absolute left-[10px] top-1.5 bottom-1.5 w-px bg-border/60" />
            <ul className="space-y-2">
              {timeline.map((item) => {
                const t = formatActivityTime(item.timestamp);
                return (
                  <li key={item.id} className="flex gap-3 relative">
                    <div className="w-5 h-5 flex items-center justify-center shrink-0 z-10 bg-background mt-0.5">
                      {item.icon}
                    </div>
                    <div className="flex-1 min-w-0 pb-1.5">
                      <p className="text-sm text-foreground/90">{item.description}</p>
                      <p
                        className="text-xs text-muted-foreground mt-0.5"
                        title={t.full}
                      >
                        {t.display}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <div className="h-12" />

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
      const isClientClosed = contact.pipeline === "Sales" && selectedStage === "Client Closed";
      const effectiveStage = isClientClosed ? "New Client Waiting for Onboarding Form" : selectedStage;

      await updateContact.mutateAsync({
        id: contact.id,
        stage: effectiveStage,
        stage_entered_at: new Date().toISOString(),
        ...(isClientClosed ? { pipeline: "Onboarding" } : {}),
      });
      const label = isClientClosed
        ? "Onboarding → Waiting for Onboarding Form"
        : (stages.find((s) => s.key === selectedStage)?.label || selectedStage);
      await logActivity("stage_changed", `moved to ${label}`, contact.id);
      toast.success(isClientClosed ? `${contact.full_name} → Onboarding` : `Moved to ${label}`);

      const flowName = STAGE_FLOW_MAP[effectiveStage];
      if (flowName) {
        try {
          await invokeFunction(flowName, {
            contact_id: contact.id,
            business_id: contact.business_id ?? ADMIN_BUSINESS_ID,
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
          <DialogTitle>Move to Stage</DialogTitle>
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

// --- Send SMS Dialog ---

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
          <DialogTitle>Send SMS to {contact.full_name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {contact.phone && (
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              <Phone className="w-4 h-4" strokeWidth={1.5} /> {contact.phone}
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
              <Copy className="w-4 h-4 mr-1" strokeWidth={1.5} /> Queue & Copy
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
