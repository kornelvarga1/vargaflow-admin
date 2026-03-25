import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateContact, useUpdateContact, SALES_STAGES, ONBOARDING_STAGES, LEAD_SOURCES, type Contact, type ContactInsert } from "@/hooks/useContacts";
import { useStopContactSequences } from "@/hooks/useSequences";
import { logActivity } from "@/hooks/useActivityLog";
import { MessageSquareOff } from "lucide-react";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact?: Contact | null;
  defaultStage?: string;
  defaultPipeline?: string;
}

export default function ContactFormDialog({ open, onOpenChange, contact, defaultStage, defaultPipeline }: Props) {
  const create = useCreateContact();
  const update = useUpdateContact();
  const stopSequences = useStopContactSequences();
  const isEdit = !!contact;
  const [markingReplied, setMarkingReplied] = useState(false);

  const handleMarkReplied = async () => {
    if (!contact) return;
    setMarkingReplied(true);
    try {
      await stopSequences.mutateAsync(contact.id);
      await update.mutateAsync({
        id: contact.id,
        stage: "Lead Responded",
        stage_entered_at: new Date().toISOString(),
      });
      await logActivity("marked_replied", "was marked as replied — sequences stopped", contact.id);
      toast.success(`${contact.full_name} marked as replied`, {
        description: "All active sequences stopped and pending messages cancelled.",
      });
      onOpenChange(false);
    } catch {
      toast.error("Failed to mark as replied");
    } finally {
      setMarkingReplied(false);
    }
  };

  const [form, setForm] = useState({
    full_name: "",
    email: "",
    phone: "",
    lead_source: "Other",
    stage: defaultStage || "Lead In",
    pipeline: defaultPipeline || "Sales",
    notes: "",
    tags: [] as string[],
  });

  useEffect(() => {
    if (contact) {
      setForm({
        full_name: contact.full_name,
        email: contact.email || "",
        phone: contact.phone || "",
        lead_source: contact.lead_source,
        stage: contact.stage,
        pipeline: contact.pipeline,
        notes: contact.notes || "",
        tags: contact.tags || [],
      });
    } else {
      setForm({
        full_name: "",
        email: "",
        phone: "",
        lead_source: "Other",
        stage: defaultStage || "Lead In",
        pipeline: defaultPipeline || "Sales",
        notes: "",
        tags: [],
      });
    }
  }, [contact, open, defaultStage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.full_name.trim()) {
      toast.error("Name is required");
      return;
    }
    try {
      if (isEdit) {
        await update.mutateAsync({ id: contact.id, ...form });
        toast.success("Contact updated");
      } else {
        await create.mutateAsync(form as ContactInsert);
        toast.success("Contact created");
      }
      onOpenChange(false);
    } catch {
      toast.error("Something went wrong");
    }
  };

  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-card border-border">
        <DialogHeader>
          <DialogTitle className="font-display">{isEdit ? "Edit Contact" : "Add Contact"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Full Name *</Label>
            <Input value={form.full_name} onChange={(e) => set("full_name", e.target.value)} placeholder="John Smith" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Email</Label>
              <Input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="john@example.com" />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+1 555 0100" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Lead Source</Label>
              <Select value={form.lead_source} onValueChange={(v) => set("lead_source", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LEAD_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Stage</Label>
              <Select value={form.stage} onValueChange={(v) => set("stage", v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(form.pipeline === "Onboarding" ? ONBOARDING_STAGES : SALES_STAGES).map((s) => (
                    <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-2">
            <Label>Notes</Label>
            <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Any additional notes..." rows={3} />
          </div>
          <div className="flex items-center justify-between gap-2 pt-2">
            {isEdit && contact.pipeline === "Sales" && contact.stage !== "Lead Responded" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-xs border-accent/40 text-accent-foreground hover:bg-accent/20"
                onClick={handleMarkReplied}
                disabled={markingReplied}
              >
                <MessageSquareOff className="w-3.5 h-3.5 mr-1" />
                {markingReplied ? "Stopping…" : "Mark as Replied"}
              </Button>
            ) : (
              <div />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" disabled={create.isPending || update.isPending}>
                {isEdit ? "Save Changes" : "Add Contact"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
