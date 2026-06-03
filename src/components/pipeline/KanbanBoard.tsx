import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { useUpdateContact, type Contact } from "@/hooks/useContacts";
import { useStopContactSequences } from "@/hooks/useSequences";
import { logActivity } from "@/hooks/useActivityLog";
import { invokeFunction } from "@/lib/invokeFunction";
import { ADMIN_BUSINESS_ID } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Plus, GripVertical, MoreHorizontal, MessageSquareOff, Phone } from "lucide-react";
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
  const navigate = useNavigate();
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
        stage: "Lead Responded",
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

  const triggerSequences = async (contactId: string, contact: Contact) => {
    const stage = contact.stage;
    const flowName = STAGE_FLOW_MAP[stage];
    if (!flowName) return;

    try {
      const { error } = await invokeFunction(flowName, {
        contact_id: contactId,
        business_id: contact.business_id ?? ADMIN_BUSINESS_ID,
      });
      if (error) throw error;
      toast.info(`Automation triggered: ${flowName}`, { description: "Check Message Queue for pending messages." });
    } catch (err) {
      console.error(`Failed to invoke ${flowName}:`, err);
      toast.error(`Automation failed: ${flowName}`);
    }
  };

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    const contactId = result.draggableId;
    const newStage = result.destination.droppableId;
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact || contact.stage === newStage) return;

    try {
      if (pipeline === "Sales" && newStage === "Client Closed") {
        await updateContact.mutateAsync({
          id: contactId,
          pipeline: "Onboarding",
          stage: "New Client Waiting for Onboarding Form",
          stage_entered_at: new Date().toISOString(),
        });
        toast.success(`${contact.full_name} → Onboarding`, {
          description: "Automatically moved to onboarding pipeline.",
        });
        await logActivity("stage_changed", `moved to Onboarding → Waiting for Onboarding Form`, contactId);
        await triggerSequences(contactId, { ...contact, pipeline: "Onboarding", stage: "New Client Waiting for Onboarding Form" });
      } else {
        await updateContact.mutateAsync({
          id: contactId,
          stage: newStage,
          stage_entered_at: new Date().toISOString(),
        });
        const stageLabel = stages.find((s) => s.key === newStage)?.label || newStage;
        toast.success(`${contact.full_name} → ${stageLabel}`);
        await logActivity("stage_changed", `moved to ${stageLabel}`, contactId);
        await triggerSequences(contactId, { ...contact, stage: newStage });
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
    <div className="px-4 md:px-6 pt-4 pb-4 h-full flex flex-col animate-fade-in overflow-hidden">
      <div className="flex items-center justify-between gap-4 mb-5">
        <div>
          <h1 className="font-serif text-3xl text-foreground">{title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
        </div>
        <Button onClick={() => openAddFor(defaultAddStage)}>
          <Plus className="w-4 h-4 mr-1" strokeWidth={1.75} /> {addLabel}
        </Button>
      </div>

      {isLoading ? (
        <div className="flex gap-3 md:gap-4 overflow-x-auto flex-1 pb-4 snap-x snap-mandatory md:snap-none -mx-4 px-4 md:mx-0 md:px-0">
          {stages.map((s) => (
            <div key={s.key} className="w-64 md:w-72 shrink-0 snap-start bg-secondary/40 rounded-2xl animate-pulse h-64" />
          ))}
        </div>
      ) : (
        <DragDropContext onDragEnd={handleDragEnd}>
          <div className="flex gap-3 md:gap-4 overflow-x-auto flex-1 pb-4 snap-x snap-mandatory md:snap-none -mx-4 px-4 md:mx-0 md:px-0">
            {columns.map((col) => (
              <div key={col.key} className="w-64 md:w-72 shrink-0 snap-start flex flex-col">
                <div className="flex items-center justify-between mb-3 px-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-sm font-medium text-foreground truncate">{col.label}</h3>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">{col.contacts.length}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground opacity-60 hover:opacity-100"
                    onClick={() => openAddFor(col.key)}
                  >
                    <Plus className="w-3.5 h-3.5" strokeWidth={1.5} />
                  </Button>
                </div>

                <Droppable droppableId={col.key}>
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`flex-1 rounded-2xl p-2 space-y-2 min-h-[200px] transition-colors ${
                        snapshot.isDraggingOver ? "bg-secondary/60" : "bg-secondary/30"
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
                              <div
                                className={`bg-card border border-border/60 rounded-xl cursor-pointer transition-all ${
                                  snapshot.isDragging ? "opacity-90 scale-[1.02] shadow-float" : "hover:bg-secondary/30"
                                }`}
                                onClick={() => navigate("/messages", { state: { contactId: contact.id } })}
                              >
                                <div className="p-3 flex items-start gap-2">
                                  <div
                                    {...provided.dragHandleProps}
                                    className="hidden md:block mt-0.5 opacity-0 group-hover:opacity-50 transition-opacity cursor-grab"
                                  >
                                    <GripVertical className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.5} />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between gap-2">
                                      <p className="text-[15px] font-medium text-foreground truncate">{contact.full_name}</p>
                                      {pipeline === "Sales" && contact.stage !== "Lead Responded" && (
                                        <DropdownMenu>
                                          <DropdownMenuTrigger asChild>
                                            <Button
                                              variant="ghost"
                                              size="icon"
                                              className="h-6 w-6 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                                              onClick={(e) => e.stopPropagation()}
                                            >
                                              <MoreHorizontal className="w-3.5 h-3.5" strokeWidth={1.5} />
                                            </Button>
                                          </DropdownMenuTrigger>
                                          <DropdownMenuContent align="end">
                                            <DropdownMenuItem onClick={(e) => handleMarkReplied(contact, e)}>
                                              <MessageSquareOff className="w-4 h-4 mr-2" strokeWidth={1.5} /> Mark as Replied
                                            </DropdownMenuItem>
                                          </DropdownMenuContent>
                                        </DropdownMenu>
                                      )}
                                    </div>
                                    {(contact.email || contact.phone) && (
                                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                                        {contact.email || contact.phone}
                                      </p>
                                    )}
                                    {contact.lead_source && (
                                      <span className="inline-block text-[10px] text-muted-foreground mt-1.5 px-1.5 py-0.5 rounded-full border border-border/60">
                                        {contact.lead_source}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
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
