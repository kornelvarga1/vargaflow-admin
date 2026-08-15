import { useState, useMemo, useCallback, memo } from "react";
import { DragDropContext, Droppable, Draggable, type DraggableProvided, type DraggableStateSnapshot, type DropResult } from "@hello-pangea/dnd";
import { useUpdateContact, type Contact, OUTREACH_STAGES } from "@/hooks/useContacts";
import { logActivity } from "@/hooks/useActivityLog";
import { invokeFunction } from "@/lib/invokeFunction";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { GripVertical, MoreHorizontal, ThumbsUp, CalendarCheck, Ban, MessageSquareOff, Search, MessageSquarePlus, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAddToDNC } from "@/hooks/useDNC";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import EnrollDialog from "@/components/outreach/EnrollDialog";
import { ConversationDrawer } from "@/components/inbox/ConversationDrawer";

const ANGLE_LABEL: Record<string, string> = {
  free_website: "Free Website",
  leads_incentive: "Leads Incentive",
  free_trial_incentive: "Free Trial",
};
const ANGLE_DOT: Record<string, string> = {
  free_website: "bg-blue-400",
  leads_incentive: "bg-emerald-400",
  free_trial_incentive: "bg-amber-400",
};

const ANGLE_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "free_website", label: "Free Website" },
  { key: "leads_incentive", label: "Leads Incentive" },
  { key: "free_trial_incentive", label: "Free Trial" },
];

// Angles that get a warm follow-up sequence when a contact replies positively.
const WARM_ELIGIBLE_ANGLES = new Set(["leads_incentive", "free_trial_incentive"]);

interface LastInbound {
  contact_id: string;
  message_content: string;
  created_at: string;
}

function useLastInboundByContact(contactIds: string[]) {
  return useQuery({
    queryKey: ["last-inbound", contactIds.sort().join(",")],
    enabled: contactIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("message_queue")
        .select("contact_id, message_content, created_at")
        .eq("direction", "inbound")
        .in("contact_id", contactIds)
        .order("created_at", { ascending: false });
      if (error) throw error;
      const byContact = new Map<string, LastInbound>();
      for (const row of (data ?? []) as LastInbound[]) {
        if (!byContact.has(row.contact_id)) byContact.set(row.contact_id, row);
      }
      return byContact;
    },
  });
}

interface Props {
  contacts: Contact[];
  isLoading: boolean;
}

interface OutreachCardProps {
  contact: Contact;
  isSelected: boolean;
  angle: string;
  inbound: LastInbound | undefined;
  provided: DraggableProvided;
  snapshot: DraggableStateSnapshot;
  onToggle: (id: string) => void;
  onOpenDrawer: (contact: Contact) => void;
  onMoveTo: (contact: Contact, stage: string) => void;
  onDNC: (contact: Contact) => void;
}

// Selecting/toggling one card used to re-render every card on the board (up to
// ~4000+ across all columns at once, each with a Draggable + Radix dropdown +
// checkbox) since `selected` lives in one Set at the board level. Memoized so
// only cards whose own props actually changed re-render — the difference
// between one checkbox click being instant vs. freezing the tab for 1000+
// contacts (and, per Kornél, breaking "Select all" past ~1150).
const OutreachCard = memo(function OutreachCard({
  contact,
  isSelected,
  angle,
  inbound,
  provided,
  snapshot,
  onToggle,
  onOpenDrawer,
  onMoveTo,
  onDNC,
}: OutreachCardProps) {
  return (
    <div
      ref={provided.innerRef}
      {...provided.draggableProps}
      className={`group ${snapshot.isDragging ? "z-50" : ""}`}
    >
      <div
        className={`bg-card border rounded-xl cursor-pointer transition-all ${
          isSelected ? "border-primary/60 bg-secondary/40" : "border-border/60 hover:bg-secondary/30"
        } ${snapshot.isDragging ? "opacity-90 scale-[1.02] shadow-float" : ""}`}
        onClick={() => onOpenDrawer(contact)}
      >
        <div className="p-3 flex items-start gap-2">
          <div
            onClick={(e) => { e.stopPropagation(); onToggle(contact.id); }}
            className="mt-0.5 shrink-0"
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => onToggle(contact.id)}
              aria-label={`Select ${contact.full_name}`}
            />
          </div>
          <div
            {...provided.dragHandleProps}
            className="hidden md:block mt-0.5 opacity-0 group-hover:opacity-50 transition-opacity cursor-grab"
          >
            <GripVertical className="w-3.5 h-3.5 text-muted-foreground" strokeWidth={1.5} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[15px] font-medium text-foreground truncate">{contact.full_name}</p>
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
                <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenuItem onClick={() => onMoveTo(contact, "Interested – Positive Reply")}>
                    <ThumbsUp className="w-4 h-4 mr-2" strokeWidth={1.5} /> Mark Interested
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onMoveTo(contact, "Follow-up 1")}>
                    <MessageSquareOff className="w-4 h-4 mr-2" strokeWidth={1.5} /> Move to Follow-up 1
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onMoveTo(contact, "Appt Set")}>
                    <CalendarCheck className="w-4 h-4 mr-2" strokeWidth={1.5} /> Mark Appt Set
                  </DropdownMenuItem>
                  <DropdownMenuItem className="text-destructive" onClick={() => onDNC(contact)}>
                    <Ban className="w-4 h-4 mr-2" strokeWidth={1.5} /> DNC
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {contact.phone && (
              <p className="text-[11px] text-muted-foreground mt-0.5 truncate">{contact.phone}</p>
            )}
            {angle && (
              <div className="inline-flex items-center gap-1 mt-1.5 px-1.5 py-0.5 rounded-full border border-border/60">
                <span className={`w-1.5 h-1.5 rounded-full ${ANGLE_DOT[angle] ?? "bg-muted-foreground"}`} />
                <span className="text-[10px] text-muted-foreground">{ANGLE_LABEL[angle] ?? angle}</span>
              </div>
            )}
            {inbound && (
              <div className="mt-1.5 text-[11px] text-muted-foreground">
                <p className="line-clamp-2 leading-snug">"{inbound.message_content}"</p>
                <p className="text-[10px] mt-0.5 opacity-70">
                  {formatDistanceToNow(new Date(inbound.created_at), { addSuffix: true })}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

export default function OutreachBoard({ contacts, isLoading }: Props) {
  const updateContact = useUpdateContact();
  const addToDNC = useAddToDNC();
  const [angleFilter, setAngleFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerContact, setDrawerContact] = useState<{ id: string; name: string; phone: string | null } | null>(null);

  const toggleOne = useCallback((id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    }), []);
  const clearSelection = () => setSelected(new Set());
  const openDrawer = useCallback((contact: Contact) => {
    setDrawerContact({ id: contact.id, name: contact.full_name, phone: contact.phone ?? null });
    setDrawerOpen(true);
  }, []);

  const filtered = useMemo(() => {
    const s = search.toLowerCase();
    return contacts.filter((c) => {
      const matchAngle = angleFilter === "all" || c.outreach_angle === angleFilter;
      const matchSearch =
        !s ||
        c.full_name.toLowerCase().includes(s) ||
        c.phone?.toLowerCase().includes(s) ||
        c.email?.toLowerCase().includes(s);
      return matchAngle && matchSearch;
    });
  }, [contacts, angleFilter, search]);

  const ids = useMemo(() => filtered.map((c) => c.id), [filtered]);
  const { data: lastInbound } = useLastInboundByContact(ids);

  const columns = OUTREACH_STAGES.map((stage) => ({
    ...stage,
    contacts: filtered
      .filter((c) => c.stage === stage.key)
      .sort((a, b) => {
        const aTime = a.stage_entered_at ?? a.created_at;
        const bTime = b.stage_entered_at ?? b.created_at;
        return new Date(bTime).getTime() - new Date(aTime).getTime();
      }),
  }));

  // When a warm-eligible contact is moved to "Interested – Positive Reply",
  // enroll them in that angle's warm follow-up sequence. Fire-and-forget:
  // the stage change is already committed; a failed enrollment shows a toast but
  // does not roll back the stage.
  const maybeEnrollWarm = useCallback(async (contact: Contact, newStage: string) => {
    if (newStage !== "Interested – Positive Reply") return;
    if (!contact.outreach_angle || !WARM_ELIGIBLE_ANGLES.has(contact.outreach_angle)) return;
    const { error } = await invokeFunction("flow-outreach-warm-enroll", {
      contact_id: contact.id,
      angle: contact.outreach_angle,
    });
    if (error) {
      console.error("[OutreachBoard] warm enroll failed:", error);
      toast.error("Warm sequence enroll failed", { description: String(error) });
    }
  }, []);

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
      const stageLabel = OUTREACH_STAGES.find((s) => s.key === newStage)?.label || newStage;
      await logActivity("stage_changed", `moved to ${stageLabel}`, contactId);
      toast.success(`${contact.full_name} → ${stageLabel}`);
      await maybeEnrollWarm(contact, newStage);
    } catch {
      toast.error("Failed to move contact");
    }
  };

  const moveTo = useCallback(async (contact: Contact, stage: string) => {
    try {
      await updateContact.mutateAsync({
        id: contact.id,
        stage,
        stage_entered_at: new Date().toISOString(),
      });
      await logActivity("stage_changed", `moved to ${stage}`, contact.id);
      toast.success(`${contact.full_name} → ${stage}`);
      await maybeEnrollWarm(contact, stage);
    } catch {
      toast.error("Failed to update stage");
    }
  }, [updateContact, maybeEnrollWarm]);

  const handleDNC = useCallback(async (contact: Contact) => {
    if (!contact.phone) {
      toast.error("Contact has no phone number");
      return;
    }
    try {
      await addToDNC.mutateAsync({
        phone: contact.phone,
        reason: "manual",
        source_workflow: contact.outreach_angle ?? null,
        contact_id: contact.id,
      });
      toast.success(`${contact.full_name} DNC'd`, {
        description: "Sequences stopped, stage → Not Interested.",
      });
    } catch (err) {
      toast.error("Failed to DNC", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [addToDNC]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <div className="relative max-w-xs flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
          <Input
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9 bg-secondary/40 border-0 focus-visible:ring-1 focus-visible:ring-ring/50"
          />
        </div>
        <div role="tablist" className="inline-flex items-center bg-secondary/60 rounded-full p-0.5">
          {ANGLE_FILTERS.map((a) => (
            <button
              key={a.key}
              role="tab"
              aria-selected={angleFilter === a.key}
              onClick={() => setAngleFilter(a.key)}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                angleFilter === a.key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {a.key !== "all" && <span className={`w-2 h-2 rounded-full ${ANGLE_DOT[a.key]}`} />}
              {a.label}
            </button>
          ))}
        </div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {filtered.length} of {contacts.length}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 bg-secondary/60 rounded-2xl px-4 py-2.5 mb-3">
          <div className="text-sm">
            <span className="font-medium">{selected.size}</span> selected
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setEnrollOpen(true)}>
              <MessageSquarePlus className="w-4 h-4 mr-1" strokeWidth={1.5} />
              Enroll
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              <X className="w-4 h-4" strokeWidth={1.5} />
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex gap-3 overflow-x-auto flex-1 pb-4">
          {OUTREACH_STAGES.map((s) => (
            <div key={s.key} className="w-64 md:w-72 shrink-0 bg-secondary/40 rounded-2xl animate-pulse h-64" />
          ))}
        </div>
      ) : (
        <DragDropContext onDragEnd={handleDragEnd}>
          <div className="flex gap-3 md:gap-4 overflow-x-auto flex-1 pb-4 snap-x snap-mandatory md:snap-none -mx-4 px-4 md:mx-0 md:px-0">
            {columns.map((col) => {
              const allColSelected =
                col.contacts.length > 0 && col.contacts.every((c) => selected.has(c.id));
              const toggleCol = () =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (allColSelected) col.contacts.forEach((c) => next.delete(c.id));
                  else col.contacts.forEach((c) => next.add(c.id));
                  return next;
                });
              return (
              <div key={col.key} className="w-64 md:w-72 shrink-0 snap-start flex flex-col">
                <div className="flex items-center justify-between mb-3 px-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <h3 className="text-sm font-medium text-foreground truncate">{col.label}</h3>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">{col.contacts.length}</span>
                  </div>
                  {col.contacts.length > 0 && (
                    <button
                      onClick={toggleCol}
                      className="text-[11px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
                    >
                      {allColSelected ? "Clear" : "Select all"}
                    </button>
                  )}
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
                      {col.contacts.map((contact, idx) => {
                        const inbound = lastInbound?.get(contact.id);
                        const angle = contact.outreach_angle ?? "";
                        const isSelected = selected.has(contact.id);
                        return (
                          <Draggable key={contact.id} draggableId={contact.id} index={idx}>
                            {(provided, snapshot) => (
                              <OutreachCard
                                contact={contact}
                                isSelected={isSelected}
                                angle={angle}
                                inbound={inbound}
                                provided={provided}
                                snapshot={snapshot}
                                onToggle={toggleOne}
                                onOpenDrawer={openDrawer}
                                onMoveTo={moveTo}
                                onDNC={handleDNC}
                              />
                            )}
                          </Draggable>
                        );
                      })}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </div>
              );
            })}
          </div>
        </DragDropContext>
      )}

      <EnrollDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        contactIds={[...selected]}
        onEnrolled={clearSelection}
      />

      <ConversationDrawer
        contactId={drawerContact?.id ?? null}
        contactName={drawerContact?.name ?? ""}
        contactPhone={drawerContact?.phone ?? null}
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
      />
    </div>
  );
}
