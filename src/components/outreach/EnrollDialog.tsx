import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEnrollOutreach, OUTREACH_WORKFLOWS, type OutreachWorkflow } from "@/hooks/useOutreach";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactIds: string[];
  onEnrolled?: () => void;
}

export default function EnrollDialog({ open, onOpenChange, contactIds, onEnrolled }: Props) {
  const [workflow, setWorkflow] = useState<OutreachWorkflow>("free_website");
  const enroll = useEnrollOutreach();

  useEffect(() => {
    if (open) setWorkflow("free_website");
  }, [open]);

  const handleEnroll = async () => {
    try {
      const result = await enroll.mutateAsync({ contact_ids: contactIds, workflow });
      const enrolledN = result.enrolled.length;
      const skippedN = result.skipped.length;

      if (enrolledN > 0) {
        toast.success(
          skippedN > 0
            ? `Enrolled ${enrolledN}, skipped ${skippedN}`
            : `Enrolled ${enrolledN} contact${enrolledN === 1 ? "" : "s"}`,
          {
            description: skippedN > 0 ? skipReasons(result.skipped) : undefined,
          },
        );
      } else {
        toast.error(`Nothing enrolled — ${skippedN} skipped`, {
          description: skipReasons(result.skipped),
        });
      }

      onEnrolled?.();
      onOpenChange(false);
    } catch (err) {
      toast.error("Enrollment failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const selected = OUTREACH_WORKFLOWS.find((w) => w.value === workflow);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Enroll in SMS Outreach</DialogTitle>
          <DialogDescription>
            {contactIds.length} contact{contactIds.length === 1 ? "" : "s"} selected. DNC-listed numbers and already-enrolled contacts will be skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label htmlFor="workflow">Workflow</Label>
          <Select value={workflow} onValueChange={(v) => setWorkflow(v as OutreachWorkflow)}>
            <SelectTrigger id="workflow">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OUTREACH_WORKFLOWS.map((w) => (
                <SelectItem key={w.value} value={w.value}>
                  {w.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected && (
            <p className="text-xs text-muted-foreground">{selected.description}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={enroll.isPending}>
            Cancel
          </Button>
          <Button onClick={handleEnroll} disabled={enroll.isPending || contactIds.length === 0}>
            {enroll.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Enroll
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function skipReasons(skipped: { name: string; reason: string }[]): string {
  if (skipped.length === 0) return "";
  if (skipped.length <= 3) return skipped.map((s) => `${s.name}: ${s.reason}`).join(" · ");
  const sample = skipped.slice(0, 2).map((s) => `${s.name}: ${s.reason}`).join(" · ");
  return `${sample} · +${skipped.length - 2} more`;
}
