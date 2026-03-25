import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { SALES_STAGES, ONBOARDING_STAGES } from "@/hooks/useContacts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Flame,
  CheckCircle,
  UserX,
  Clock,
  AlertTriangle,
  Zap,
  ArrowRight,
  Loader2,
} from "lucide-react";
import { differenceInDays, formatDistanceToNow } from "date-fns";

const ALL_STAGES = [
  ...SALES_STAGES.map((s) => ({ ...s, pipeline: "Sales" })),
  ...ONBOARDING_STAGES.map((s) => ({ ...s, pipeline: "Onboarding" })),
];

interface AttentionItem {
  id: string;
  contactId: string;
  contactName: string;
  type: "no_show" | "stale" | "failed_automation" | "replied";
  description: string;
  timestamp?: string;
}

function useNeedsAttention() {
  return useQuery({
    queryKey: ["needs_attention"],
    queryFn: async () => {
      const items: AttentionItem[] = [];

      // Fetch all in parallel
      const [contactsRes, failedSeqRes, repliedRes] = await Promise.all([
        supabase.from("contacts").select("id, full_name, stage, pipeline, stage_entered_at"),
        supabase
          .from("contact_sequences")
          .select("id, contact_id, status, updated_at, contacts(full_name), sequences(name)")
          .eq("status", "failed"),
        supabase
          .from("activity_log")
          .select("id, contact_id, description, created_at, contacts(full_name)")
          .eq("activity_type", "marked_replied")
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

      const contacts = contactsRes.data || [];
      const now = new Date();

      // No-showed Zoom contacts
      const noShowed = contacts.filter((c) => c.stage === "No Showed to Zoom");
      for (const c of noShowed) {
        items.push({
          id: `noshow-${c.id}`,
          contactId: c.id,
          contactName: c.full_name,
          type: "no_show",
          description: c.stage_entered_at
            ? `No-showed Zoom — ${formatDistanceToNow(new Date(c.stage_entered_at), { addSuffix: true })}`
            : "No-showed Zoom",
          timestamp: c.stage_entered_at,
        });
      }

      // Stale contacts (same stage for 5+ days)
      const terminalStages = ["Client Closed", "Client Churned", "Approved Retainer"];
      for (const c of contacts) {
        if (!c.stage_entered_at) continue;
        const days = differenceInDays(now, new Date(c.stage_entered_at));
        if (days >= 5) {
          if (terminalStages.includes(c.stage)) continue;
          if (c.stage === "No Showed to Zoom") continue;

          const stageLabel = ALL_STAGES.find((s) => s.key === c.stage && s.pipeline === c.pipeline)?.label || c.stage;
          items.push({
            id: `stale-${c.id}`,
            contactId: c.id,
            contactName: c.full_name,
            type: "stale",
            description: `Stuck in "${stageLabel}" for ${days} days`,
            timestamp: c.stage_entered_at,
          });
        }
      }

      // Failed automations
      const failedSeqs = failedSeqRes.data || [];
      for (const seq of failedSeqs) {
        const name = (seq as any).contacts?.full_name || "Unknown";
        const seqName = (seq as any).sequences?.name || "Unknown sequence";
        items.push({
          id: `failed-${seq.id}`,
          contactId: seq.contact_id,
          contactName: name,
          type: "failed_automation",
          description: `Automation "${seqName}" failed`,
          timestamp: seq.updated_at,
        });
      }

      // Recent replies (marked_replied activity)
      const replies = repliedRes.data || [];
      for (const r of replies) {
        const name = (r as any).contacts?.full_name || "Unknown";
        items.push({
          id: `replied-${r.id}`,
          contactId: r.contact_id || "",
          contactName: name,
          type: "replied",
          description: `Replied — needs follow-up`,
          timestamp: r.created_at,
        });
      }

      // Sort: most recent first
      items.sort((a, b) => {
        if (!a.timestamp || !b.timestamp) return 0;
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });

      return items;
    },
    refetchInterval: 30000,
  });
}

const typeConfig: Record<string, { icon: typeof Flame; badgeVariant: "default" | "secondary" | "destructive" | "outline" }> = {
  no_show: { icon: UserX, badgeVariant: "destructive" },
  stale: { icon: Clock, badgeVariant: "secondary" },
  failed_automation: { icon: AlertTriangle, badgeVariant: "destructive" },
  replied: { icon: Zap, badgeVariant: "default" },
};

const typeLabel: Record<string, string> = {
  no_show: "No Show",
  stale: "Stale",
  failed_automation: "Failed",
  replied: "Replied",
};

export default function NeedsAttentionSection() {
  const { data: items = [], isLoading } = useNeedsAttention();

  if (isLoading) {
    return (
      <Card className="bg-card border-border shadow-card">
        <CardContent className="p-6 flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border shadow-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-display">
          <Flame className="w-5 h-5 text-primary" />
          Needs Attention 🔥
          {items.length > 0 && (
            <Badge variant="destructive" className="ml-auto text-xs">
              {items.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="flex items-center gap-2 py-3 text-sm">
            <CheckCircle className="w-5 h-5 text-primary" />
            <span>All clear — no action needed right now ✅</span>
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => {
              const config = typeConfig[item.type] || typeConfig.stale;
              const Icon = config.icon;
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-3 p-3 rounded-lg bg-secondary/30 hover:bg-secondary/50 transition-colors"
                >
                  <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4 text-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{item.contactName}</p>
                    <p className="text-xs text-muted-foreground truncate">{item.description}</p>
                  </div>
                  <Badge variant={config.badgeVariant} className="text-[10px] shrink-0">
                    {typeLabel[item.type]}
                  </Badge>
                  {item.contactId && (
                    <Link to={`/contacts/${item.contactId}`}>
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                        <ArrowRight className="w-4 h-4" />
                      </Button>
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
