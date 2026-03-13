import { useState } from "react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { useUpdateContact, type Contact } from "@/hooks/useContacts";
import { useEnrollContact, generateSequenceMessages, useStopContactSequences } from "@/hooks/useSequences";
import { logActivity } from "@/hooks/useActivityLog";
import { supabase } from "@/lib/supabase";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Plus, Mail, Phone, GripVertical, MoreHorizontal, MessageSquareOff } from "lucide-react";
import ContactFormDialog from "@/components/contacts/ContactFormDialog";
import { toast } from "sonner";

interface Stage {
  key: string;
  label: string;
}

interface Props {
  title: string;
  subtitle: string;
  addLabel: string;
  pipeline: string;
  stages: readonly Stage[];
  contacts: Contact[];
  isLoading: boolean;
  defaultAddStage: string;
}

export default function KanbanBoard({ title, subtitle, addLabel, pipeline, stages, contacts, isLoading, defaultAddStage }: Props) {
  const updateContact = useUpdateContact();
  const stopSequences = useStopContactSequences();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [defaultStage, setDefaultStage] = useState(defaultAddStage);

  const handleMarkReplied = async (contact: Contact, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await stopSequences.mutateAsync(contact.id);
      await updateContact.mutateAsync({
        id: contact.id,
        stage: "lead_responded",
        stage_entered_at: new Date().toISOString(),
      });
      await logActivity("marked_replied", "was marked as replied — sequences stopped", contact.id);
      toast.success(`${contact.full_name} marked as replied`, {
        description: "All active sequences stopped.",
      });
    } catch {
      toast.error("Failed to mark as replied");
    }
  };

  const columns = stages.map((stage) => ({
    ...stage,
    contacts: contacts.filter((c) => c.stage === stage.key),
  }));

  /** Check for active sequences matching a pipeline+stage and enroll the contact */
  const triggerSequences = async (contactId: string, targetPipeline: string, targetStage: string) => {
    const { data: activeSeqs } = await supabase
      .from("sequences")
      .select("id")
      .eq("pipeline", targetPipeline)
      .eq("stage", targetStage)
      .eq("is_active", true);

    if (activeSeqs && activeSeqs.length > 0) {
      for (const seq of activeSeqs) {
        // Enroll
        const { data: enrollment } = await supabase
          .from("contact_sequences")
          .insert({ contact_id: contactId, sequence_id: seq.id, status: "active", current_step: 0 })
          .select()
          .single();
        if (enrollment) {
          await generateSequenceMessages(contactId, seq.id, enrollment.id);
        }
      }
      toast.info(`Enrolled in ${activeSeqs.length} sequence(s)`, { description: "Check Message Queue for pending messages." });
    }
  };

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    const contactId = result.draggableId;
    const newStage = result.destination.droppableId;
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact || contact.stage === newStage) return;

    try {
      // Auto-move to onboarding when dropped in "Closed / Won"
      if (pipeline === "sales" && newStage === "client_closed") {
        await updateContact.mutateAsync({
          id: contactId,
          pipeline: "onboarding",
          stage: "waiting_onboarding_form",
          stage_entered_at: new Date().toISOString(),
        });
        toast.success(`${contact.full_name} → Onboarding`, {
          description: "Automatically moved to onboarding pipeline.",
        });
        await logActivity("stage_changed", `moved to Onboarding → Waiting for Onboarding Form`, contactId);
        await triggerSequences(contactId, "onboarding", "waiting_onboarding_form");
      } else {
        await updateContact.mutateAsync({
          id: contactId,
          stage: newStage,
          stage_entered_at: new Date().toISOString(),
        });
        const stageLabel = stages.find((s) => s.key === newStage)?.label || newStage;
        toast.success(`${contact.full_name} → ${stageLabel}`);
        await logActivity("stage_changed", `moved to ${stageLabel}`, contactId);
        await triggerSequences(contactId, pipeline, newStage);
      }
    } catch {
      toast.error("Failed to move contact");
    }
  };

  const openAddFor = (stageKey: string) => {
    setEditing(null);
    setDefaultStage(stageKey);
    setDialogOpen(true);
  };

  return (
    <div className="p-4 md:p-6 h-full flex flex-col animate-fade-in overflow-hidden">
      <div className="flex items-center justify-between gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-display font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        <Button onClick={() => openAddFor(defaultAddStage)}>
          <Plus className="w-4 h-4 mr-1" /> {addLabel}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex gap-3 md:gap-4 overflow-x-auto flex-1 pb-4 snap-x snap-mandatory md:snap-none -mx-4 px-4 md:mx-0 md:px-0">
          {stages.map((s) => (
            <div key={s.key} className="w-64 md:w-72 shrink-0 snap-start bg-secondary/50 rounded-lg animate-pulse h-64" />
          ))}
        </div>
      ) : (
        <DragDropContext onDragEnd={handleDragEnd}>
          <div className="flex gap-3 md:gap-4 overflow-x-auto flex-1 pb-4 snap-x snap-mandatory md:snap-none -mx-4 px-4 md:mx-0 md:px-0">
            {columns.map((col) => (
              <div key={col.key} className="w-64 md:w-72 shrink-0 snap-start flex flex-col">
                <div className="flex items-center justify-between mb-3 px-1">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-display font-semibold">{col.label}</h3>
                    <Badge variant="secondary" className="text-xs h-5 min-w-[1.25rem] flex items-center justify-center">
                      {col.contacts.length}
                    </Badge>
                  </div>
                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openAddFor(col.key)}>
                    <Plus className="w-3.5 h-3.5" />
                  </Button>
                </div>

                <Droppable droppableId={col.key}>
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`flex-1 rounded-lg p-2 space-y-2 min-h-[200px] transition-colors ${
                        snapshot.isDraggingOver ? "bg-accent/30 border border-accent/50" : "bg-secondary/30"
                      }`}
                    >
                      {col.contacts.map((contact, idx) => (
                        <Draggable key={contact.id} draggableId={contact.id} index={idx}>
                          {(provided, snapshot) => (
                            <div
                              ref={provided.innerRef}
                              {...provided.draggableProps}
                              className={`group ${snapshot.isDragging ? "z-50" : ""}`}
                            >
                              <Card
                                className={`bg-card border-border cursor-pointer transition-all ${
                                  snapshot.isDragging ? "shadow-glow rotate-1" : "hover:border-accent/40"
                                }`}
                                onClick={() => { setEditing(contact); setDialogOpen(true); }}
                              >
                                <CardContent className="p-3 flex items-start gap-2">
                                  <div
                                    {...provided.dragHandleProps}
                                    className="mt-0.5 opacity-0 group-hover:opacity-50 transition-opacity cursor-grab"
                                  >
                                    <GripVertical className="w-4 h-4 text-muted-foreground" />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between">
                                      <p className="text-sm font-medium font-display truncate">{contact.full_name}</p>
                                      {pipeline === "sales" && contact.stage !== "lead_responded" && (
                                        <DropdownMenu>
                                          <DropdownMenuTrigger asChild>
                                            <Button
                                              variant="ghost"
                                              size="icon"
                                              className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              <MoreHorizontal className="w-3.5 h-3.5" />
                                            </Button>
                                          </DropdownMenuTrigger>
                                          <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={(e) => handleMarkReplied(contact, e)}>
                                              <MessageSquareOff className="w-4 h-4 mr-2" /> Mark as Replied
                                            </DropdownMenuItem>
                                          </DropdownMenuContent>
                                        </DropdownMenu>
                                      )}
                                    </div>
                                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                                      {contact.email && (
                                        <span className="flex items-center gap-0.5 truncate">
                                          <Mail className="w-3 h-3" />
                                          <span className="truncate">{contact.email}</span>
                                        </span>
                                      )}
                                      {contact.phone && (
                                        <span className="flex items-center gap-0.5">
                                          <Phone className="w-3 h-3" />
                                        </span>
                                      )}
                                    </div>
                                    <Badge variant="secondary" className="text-[10px] mt-1.5 h-4">
                                      {contact.lead_source}
                                    </Badge>
                                  </div>
                                </CardContent>
                              </Card>
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </div>
            ))}
          </div>
        </DragDropContext>
      )}

      <ContactFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        contact={editing}
        defaultStage={defaultStage}
        defaultPipeline={pipeline}
      />
    </div>
  );
}
