import { Link } from "react-router-dom";
import { useDashboardStats } from "@/hooks/useDashboardStats";
import { useActivityLog } from "@/hooks/useActivityLog";
import { SALES_STAGES, ONBOARDING_STAGES } from "@/hooks/useContacts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Users,
  Kanban,
  Zap,
  MessageSquare,
  Send,
  ListChecks,
  Clock,
  ArrowRight,
  Loader2,
  UserPlus,
  ArrowRightLeft,
  Mail,
  CheckCircle,
  Activity,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const activityIcons: Record<string, typeof Activity> = {
  contact_created: UserPlus,
  stage_changed: ArrowRightLeft,
  message_sent: Send,
  sequence_enrolled: ListChecks,
  contact_updated: Users,
};

export default function Index() {
  const { data: stats, isLoading: statsLoading } = useDashboardStats();
  const { data: activities = [], isLoading: actLoading } = useActivityLog(15);

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 animate-fade-in">
      <div>
        <h1 className="text-3xl font-display font-bold">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Welcome back to Local Scaling CRM</p>
      </div>

      {/* Top stat cards */}
      {statsLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard
              icon={Users}
              label="Total Contacts"
              value={stats?.totalContacts ?? 0}
              to="/contacts"
            />
            <StatCard
              icon={MessageSquare}
              label="Pending Messages"
              value={stats?.pendingMessages ?? 0}
              to="/messages"
              highlight={!!stats?.pendingMessages}
            />
            <StatCard
              icon={Send}
              label="Messages Sent"
              value={stats?.sentMessages ?? 0}
              to="/messages"
            />
            <StatCard
              icon={ListChecks}
              label="Active Sequences"
              value={stats?.activeSequences ?? 0}
              to="/sequences"
            />
          </div>

          {/* Pipeline breakdowns */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <PipelineCard
              title="Sales Pipeline"
              icon={Kanban}
              stages={SALES_STAGES}
              data={stats?.salesByStage || {}}
              to="/pipeline/sales"
            />
            <PipelineCard
              title="Client Onboarding"
              icon={Zap}
              stages={ONBOARDING_STAGES}
              data={stats?.onboardingByStage || {}}
              to="/pipeline/onboarding"
            />
          </div>
        </>
      )}

      {/* Activity Log */}
      <Card className="bg-card border-border shadow-card">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-display">
            <Clock className="w-4 h-4 text-accent-foreground" />
            Recent Activity
          </CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-4">
          {actLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : activities.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No activity yet. Start by adding contacts and moving them through your pipelines.
            </p>
          ) : (
            <div className="space-y-3">
              {activities.map((a) => {
                const Icon = activityIcons[a.activity_type] || Activity;
                return (
                  <div key={a.id} className="flex items-start gap-3">
                    <div className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center shrink-0 mt-0.5">
                      <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">
                        {a.contacts?.full_name && (
                          <span className="font-medium text-accent-foreground">{a.contacts.full_name}</span>
                        )}{" "}
                        {a.description}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  to,
  highlight,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  to: string;
  highlight?: boolean;
}) {
  return (
    <Link to={to}>
      <Card
        className={`bg-card border-border shadow-card hover:shadow-glow transition-shadow cursor-pointer group ${
          highlight ? "border-accent/50" : ""
        }`}
      >
        <CardContent className="p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <Icon className="w-4 h-4 text-muted-foreground group-hover:text-accent-foreground transition-colors" />
            <ArrowRight className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
          <div>
            <p className={`text-2xl font-display font-bold ${highlight ? "text-accent-foreground" : ""}`}>
              {value}
            </p>
            <p className="text-xs text-muted-foreground">{label}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function PipelineCard({
  title,
  icon: Icon,
  stages,
  data,
  to,
}: {
  title: string;
  icon: typeof Kanban;
  stages: readonly { key: string; label: string }[];
  data: Record<string, number>;
  to: string;
}) {
  const total = Object.values(data).reduce((a, b) => a + b, 0);

  return (
    <Link to={to}>
      <Card className="bg-card border-border shadow-card hover:shadow-glow transition-shadow cursor-pointer group">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Icon className="w-4 h-4 text-accent-foreground" />
              <span className="font-display font-semibold text-sm">{title}</span>
            </div>
            <Badge variant="secondary" className="text-xs">{total} total</Badge>
          </div>
          <div className="space-y-1.5">
            {stages.map((s) => {
              const count = data[s.key] || 0;
              const pct = total > 0 ? (count / total) * 100 : 0;
              return (
                <div key={s.key} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-28 truncate">{s.label}</span>
                  <div className="flex-1 h-2 bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full gradient-primary transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs font-medium w-6 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
