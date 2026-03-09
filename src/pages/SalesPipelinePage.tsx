import { useState } from "react";
import { DragDropContext, Droppable, Draggable, type DropResult } from "@hello-pangea/dnd";
import { useContacts, useUpdateContact, SALES_STAGES, type Contact } from "@/hooks/useContacts";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus, Mail, Phone, GripVertical } from "lucide-react";
import ContactFormDialog from "@/components/contacts/ContactFormDialog";
import { toast } from "sonner";

export default function SalesPipelinePage() {
  const { data: contacts = [], isLoading } = useContacts("sales");
  const updateContact = useUpdateContact();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [defaultStage, setDefaultStage] = useState<string>("lead_in");

  const columns = SALES_STAGES.map((stage) => ({
    ...stage,
    contacts: contacts.filter((c) => c.stage === stage.key),
  }));

  const handleDragEnd = async (result: DropResult) => {
    if (!result.destination) return;
    const contactId = result.draggableId;
    const newStage = result.destination.droppableId;
    const contact = contacts.find((c) => c.id === contactId);
    if (!contact || contact.stage === newStage) return;

    try {
      await updateContact.mutateAsync({
        id: contactId,
        stage: newStage,
        stage_entered_at: new Date().toISOString(),
      });
      const stageLabel = SALES_STAGES.find((s) => s.key === newStage)?.label || newStage;
      toast.success(`${contact.full_name} → ${stageLabel}`);
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
    <div className="p-4 md:p-6 h-full flex flex-col animate-fade-in">
      <div className="flex items-center justify-between gap-4 mb-5">
        <div>
          <h1 className="text-2xl font-display font-bold">Sales Pipeline</h1>
          <p className="text-sm text-muted-foreground">{contacts.length} contacts in pipeline</p>
        </div>
        <Button onClick={() => openAddFor("lead_in")}>
          <Plus className="w-4 h-4 mr-1" /> Add Lead
        </Button>
      </div>

      {isLoading ? (
        <div className="flex gap-4 overflow-x-auto flex-1 pb-4">
          {SALES_STAGES.map((s) => (
            <div key={s.key} className="w-72 shrink-0 bg-secondary/50 rounded-lg animate-pulse h-64" />
          ))}
        </div>
      ) : (
        <DragDropContext onDragEnd={handleDragEnd}>
          <div className="flex gap-4 overflow-x-auto flex-1 pb-4">
            {columns.map((col) => (
              <div key={col.key} className="w-72 shrink-0 flex flex-col">
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
                                    <p className="text-sm font-medium font-display truncate">{contact.full_name}</p>
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
      />
    </div>
  );
}
