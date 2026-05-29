import { useState } from "react";
import { Link } from "react-router-dom";
import { useDashboardStats } from "@/hooks/useDashboardStats";
import { useActivityLog } from "@/hooks/useActivityLog";
import { useOutreachRunway } from "@/hooks/useOutreachRunway";
import { SALES_STAGES, ONBOARDING_STAGES } from "@/hooks/useContacts";

const OUTREACH_STAGES = [
  { key: "Cold List",                  label: "Cold List" },
  { key: "Sequence Active",            label: "In Sequence" },
  { key: "Replied",                    label: "Replied" },
  { key: "Interested – Positive Reply",label: "Interested" },
  { key: "Follow-up",                  label: "Follow-up" },
  { key: "Appt Set",                   label: "Appt Set" },
  { key: "Not Interested",             label: "Not Interested" },
];
import { Button } from "@/components/ui/button";
import {
  Users,
  Send,
  Loader2,
  UserPlus,
  ArrowRightLeft,
  ListChecks,
  Activity,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";

const activityIcons: Record<string, typeof Activity> = {
  contact_created: UserPlus,
  stage_changed: ArrowRightLeft,
  message_sent: Send,
  sequence_enrolled: ListChecks,
  contact_updated: Users,
};

const PERIODS: { days: number; label: string }[] = [
  { days: 1,  label: "24h" },
  { days: 7,  label: "7 days" },
  { days: 30, label: "30 days" },
];

export default function Index() {
  const [period, setPeriod] = useState(30);
  const { data: stats, isLoading: statsLoading } = useDashboardStats(period);
  const { data: activities = [], isLoading: actLoading } = useActivityLog(50);
  const { data: runway } = useOutreachRunway();
  const [activityCount, setActivityCount] = useState(8);

  return (
    <div className="px-4 md:px-8 pt-8 max-w-5xl mx-auto animate-slide-up">
      <header className="px-1 mb-6">
        <h1 className="font-serif text-3xl text-foreground">Dashboard</h1>
      </header>

      {/* Stats */}
      <div className="mt-5">
        <div className="flex justify-end mb-3">
          <div className="inline-flex items-center bg-secondary/60 rounded-full p-0.5">
            {PERIODS.map((p) => (
              <button
                key={p.days}
                onClick={() => setPeriod(p.days)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                  period === p.days
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        {statsLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Contacted" value={stats?.sentMessages ?? 0} to="/messages" />
            <StatCard label="Calls Booked" value={stats?.callsBooked ?? 0} to="/pipeline/sales" />
            <StatCard label="Clients Closed" value={stats?.clientsClosed ?? 0} to="/pipeline/onboarding" />
          </div>
        )}
      </div>

      {/* Outreach stats */}
      {!statsLoading && (stats?.outreachEnrolled ?? 0) > 0 && (
        <section className="mt-8">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground px-1 mb-3">
            Outreach
          </p>
          <div className="bg-card border border-border/60 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-4">
              <span className="font-medium text-sm text-foreground">Campaign performance</span>
              <span className="text-xs text-muted-foreground tabular-nums">{stats!.outreachEnrolled} contacted</span>
            </div>

            {runway && runway.backlog > 0 && (
              <div className="flex items-center justify-between bg-secondary/30 rounded-xl px-4 py-2.5 mb-4">
                <div>
                  <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Runway</p>
                  <p className="text-sm text-foreground tabular-nums mt-0.5">
                    <span className="font-medium">{runway.backlog}</span>
                    <span className="text-muted-foreground"> left</span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium tabular-nums text-foreground">
                    {runway.sendingDaysLeft === 0 ? "< 1 day" :
                     runway.sendingDaysLeft === 1 ? "~1 day" :
                     `~${runway.sendingDaysLeft} days`}
                  </p>
                  {runway.dryDate && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Runs dry {format(runway.dryDate, "EEE MMM d")}
                      <span className="mx-1 opacity-50">·</span>
                      {runway.dailyCap}/day
                    </p>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="bg-secondary/30 rounded-xl px-4 py-3">
                <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Reply rate</p>
                <p className="font-serif text-2xl text-foreground tabular-nums leading-none mt-1">
                  {stats!.outreachReplyRate}%
                </p>
              </div>
              <div className="bg-secondary/30 rounded-xl px-4 py-3">
                <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Positive rate</p>
                <p className="font-serif text-2xl text-foreground tabular-nums leading-none mt-1">
                  {stats!.outreachPositiveRate}%
                </p>
              </div>
            </div>
            <div className="space-y-1.5">
              {OUTREACH_STAGES.map((s) => {
                const count = stats!.outreachByStage[s.key] || 0;
                const total = Object.values(stats!.outreachByStage).reduce((a, b) => a + b, 0);
                const pct = total > 0 ? (count / total) * 100 : 0;
                return (
                  <div key={s.key} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-36 truncate">{s.label}</span>
                    <div className="flex-1 h-1.5 bg-secondary/60 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary/70 transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs tabular-nums text-foreground/80 w-6 text-right">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* Pipeline breakdowns */}
      {!statsLoading && (
        <section className="mt-8">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground px-1 mb-3">
            Pipelines
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <PipelineCard
              title="Sales"
              stages={SALES_STAGES}
              data={stats?.salesByStage || {}}
              to="/pipeline/sales"
            />
            <PipelineCard
              title="Onboarding"
              stages={ONBOARDING_STAGES}
              data={stats?.onboardingByStage || {}}
              to="/pipeline/onboarding"
            />
          </div>
        </section>
      )}

      {/* Recent Activity */}
      <section className="mt-8">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground px-1 mb-3">
          Recent Activity
        </p>
        <div className="bg-card border border-border/60 rounded-2xl p-4">
          {actLoading ? (
            <div className="flex justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : activities.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No activity yet. Start by adding contacts and moving them through your pipelines.
            </p>
          ) : (
            <ul className="space-y-3">
              {activities.slice(0, activityCount).map((a) => {
                const Icon = activityIcons[a.activity_type] || Activity;
                return (
                  <li key={a.id} className="flex items-start gap-3">
                    <Icon className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" strokeWidth={1.5} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-foreground/90 leading-snug">
                        {a.contacts?.full_name && (
                          <span className="font-medium text-foreground">{a.contacts.full_name}</span>
                        )}{" "}
                        {a.description}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {activities.length > activityCount && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs text-muted-foreground mt-2"
              onClick={() => setActivityCount((c) => c + 8)}
            >
              Show more ({activities.length - activityCount} remaining)
            </Button>
          )}
        </div>
      </section>

      <div className="h-12" />
    </div>
  );
}

function StatCard({
  label,
  value,
  to,
}: {
  label: string;
  value: number;
  to: string;
}) {
  return (
    <Link
      to={to}
      className="block bg-card border border-border/60 rounded-2xl px-4 py-4 hover:bg-secondary/20 transition-colors"
    >
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </p>
      <p className="font-serif text-3xl text-foreground tabular-nums leading-none mt-2">
        {value}
      </p>
    </Link>
  );
}

function PipelineCard({
  title,
  stages,
  data,
  to,
}: {
  title: string;
  stages: readonly { key: string; label: string }[];
  data: Record<string, number>;
  to: string;
}) {
  const total = Object.values(data).reduce((a, b) => a + b, 0);

  return (
    <Link
      to={to}
      className="block bg-card border border-border/60 rounded-2xl p-4 hover:bg-secondary/20 transition-colors"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="font-medium text-sm text-foreground">{title}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{total} total</span>
      </div>
      <div className="space-y-1.5">
        {stages.map((s) => {
          const count = data[s.key] || 0;
          const pct = total > 0 ? (count / total) * 100 : 0;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-32 truncate">{s.label}</span>
              <div className="flex-1 h-1.5 bg-secondary/60 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary/70 transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs tabular-nums text-foreground/80 w-6 text-right">{count}</span>
            </div>
          );
        })}
      </div>
    </Link>
  );
}
