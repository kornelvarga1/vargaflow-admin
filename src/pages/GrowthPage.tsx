import { useState, useEffect } from "react";
import { useUIPreferences } from "@/hooks/useUIPreferences";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";

const STORAGE_KEY = "vf_growth_inputs";
const PRICE = 297;

const BIRTHDAY_MONTH = 7;  // August (0-indexed)
const BIRTHDAY_NEXT_AGE = 23;
const BIRTHDAY_NEXT_YEAR = 2026;

const MRR_MILESTONES = [
  { mrr: 1000,   label: "Freedom from 9-5s" },
  { mrr: 3000,   label: "Budapest" },
  { mrr: 10000,  label: "F-Type" },
  { mrr: 30000,  label: "Porsche" },
  { mrr: 100000, label: "Aston Martin DBS" },
];

type Inputs = {
  messagesPerDay: number;
  replyRate: number;
  replyToCallRate: number;
  showUpRate: number;
  closeRate: number;
  churnRate: number;
  startingMRR: number;
};


const DEFAULTS: Inputs = {
  messagesPerDay: 50,
  replyRate: 3,
  replyToCallRate: 30,
  showUpRate: 70,
  closeRate: 40,
  churnRate: 5,
  startingMRR: 0,
};

function loadInputs(): Inputs {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return { ...DEFAULTS, ...JSON.parse(stored) };
  } catch {}
  return DEFAULTS;
}

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

function fmtNum(v: number) {
  if (v >= 100) return Math.round(v).toLocaleString("en-US");
  return v % 1 === 0 ? v.toString() : v.toFixed(1).replace(/\.0$/, "");
}

function fmtMoney(v: number) {
  if (v >= 1000) return `$${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

function computeFunnel(inputs: Inputs) {
  const msgs = inputs.messagesPerDay * 22;
  const replies = msgs * (inputs.replyRate / 100);
  const booked = replies * (inputs.replyToCallRate / 100);
  const held = booked * (inputs.showUpRate / 100);
  const clients = held * (inputs.closeRate / 100);
  const mrrAdded = clients * PRICE;
  const churnLoss = inputs.startingMRR * (inputs.churnRate / 100);
  const endMRR = inputs.startingMRR + mrrAdded - churnLoss;
  return { msgs, replies, booked, held, clients, mrrAdded, churnLoss, endMRR };
}

function computeMonths(inputs: Inputs, totalMonths: number) {
  const now = new Date();
  const msgs = inputs.messagesPerDay * 22;
  const mrrAdded =
    msgs *
    (inputs.replyRate / 100) *
    (inputs.replyToCallRate / 100) *
    (inputs.showUpRate / 100) *
    (inputs.closeRate / 100) *
    PRICE;
  let mrr = inputs.startingMRR;
  const nowShort = now.toLocaleString("en-US", { month: "short" });
  const nowYr = String(now.getFullYear()).slice(2);
  const nowLabel = `${nowShort} '${nowYr}`;
  let cumulative = Math.round(mrr);
  const data: { idx: number; month: string; fullMonth: string; mrr: number; cumulative: number; age: number | null }[] = [
    { idx: 0, month: "Now", fullMonth: nowLabel, mrr: Math.round(mrr), cumulative, age: null },
  ];
  for (let i = 1; i <= totalMonths; i++) {
    mrr = Math.max(0, mrr + mrrAdded - mrr * (inputs.churnRate / 100));
    cumulative += Math.round(mrr);
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const short = d.toLocaleString("en-US", { month: "short" });
    const yr = String(d.getFullYear()).slice(2);
    const fullMonth = `${short} '${yr}`;
    const isBirthday = d.getMonth() === BIRTHDAY_MONTH;
    const month = d.getMonth() === 0 ? fullMonth : short;
    const age = isBirthday ? BIRTHDAY_NEXT_AGE + (d.getFullYear() - BIRTHDAY_NEXT_YEAR) : null;
    data.push({ idx: i, month, fullMonth, mrr: Math.round(mrr), cumulative, age });
  }
  return data;
}

type InputRowProps = {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  prefix?: string;
};

function InputRow({ label, value, onChange, min, max, step, suffix, prefix }: InputRowProps) {
  const dec = (v: number) => onChange(clamp(round2(v - step), min, max));
  const inc = (v: number) => onChange(clamp(round2(v + step), min, max));
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 border-b border-border/40 last:border-0">
      <span className="text-sm text-muted-foreground flex-1 leading-tight">{label}</span>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => dec(value)}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors text-base leading-none select-none"
        >
          −
        </button>
        <div className="flex items-center gap-0.5 min-w-[3.5rem] justify-center">
          {prefix && <span className="text-xs text-muted-foreground">{prefix}</span>}
          <input
            type="number"
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) onChange(clamp(round2(v), min, max));
            }}
            className="w-12 text-center text-sm tabular-nums bg-transparent border-0 focus:outline-none text-foreground [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          {suffix && <span className="text-xs text-muted-foreground">{suffix}</span>}
        </div>
        <button
          type="button"
          onClick={() => inc(value)}
          className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors text-base leading-none select-none"
        >
          +
        </button>
      </div>
    </div>
  );
}


type TooltipProps = {
  active?: boolean;
  payload?: Array<{ value: number; payload: { fullMonth: string; cumulative: number } }>;
};

function ChartTooltip({ active, payload }: TooltipProps) {
  if (!active || !payload?.length) return null;
  const mrr = payload[0].value;
  const { fullMonth, cumulative } = payload[0].payload;
  return (
    <div className="bg-card border border-border/60 rounded-xl px-3 py-2 shadow-sm">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{fullMonth}</p>
      <p className="font-serif text-lg text-foreground tabular-nums">{fmtMoney(mrr)}</p>
      <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5">{fmtMoney(cumulative)} collected</p>
    </div>
  );
}

export default function GrowthPage() {
  const { prefs, setPref, isLoading: prefsLoading } = useUIPreferences();

  const inputs: Inputs = prefs.growth_inputs
    ? { ...DEFAULTS, ...(prefs.growth_inputs as Inputs) }
    : loadInputs();
  const months: number = (prefs.growth_months as number) ?? 12;

  const setInputs = (updater: Inputs | ((prev: Inputs) => Inputs)) => {
    const next = typeof updater === "function" ? updater(inputs) : updater;
    setPref("growth_inputs", next, 600);
  };
  const setMonths = (m: number) => setPref("growth_months", m);

  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  const set = (key: keyof Inputs) => (v: number) =>
    setInputs((prev) => ({ ...prev, [key]: v }));

  const f = computeFunnel(inputs);
  const totalMonths = months;
  const chartData = computeMonths(inputs, totalMonths);
  const endMRR = chartData[chartData.length - 1].mrr;
  const totalCollected = chartData[chartData.length - 1].cumulative;

  // explicit tick indices — ~13 on desktop, ~5 on mobile across all zoom levels
  const tickStep = Math.max(1, isMobile ? Math.round(totalMonths / 4) : Math.round(totalMonths / 12));
  const tickIndices = Array.from(
    { length: Math.round(totalMonths / tickStep) + 1 },
    (_, i) => Math.round(i * tickStep),
  );
  const maxBar = f.msgs || 1;

  const funnelSteps = [
    { label: "Messages / mo (×22 days)", value: f.msgs },
    { label: "Positive replies", value: f.replies },
    { label: "Calls booked", value: f.booked },
    { label: "Calls held", value: f.held },
    { label: "New clients / month", value: f.clients },
  ];

  return (
    <div className="px-4 md:px-6 pt-8 pb-16 max-w-5xl mx-auto animate-fade-in">
      <header className="px-1 mb-6">
        <h1 className="font-serif text-3xl text-foreground">Growth</h1>
        <p className="text-sm text-muted-foreground mt-1">Adjust the funnel, see the money.</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        {/* Inputs */}
        <div className="bg-card border border-border/60 rounded-2xl px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-1">
            Cold outreach
          </p>
          <InputRow
            label="Messages / business day"
            value={inputs.messagesPerDay}
            onChange={set("messagesPerDay")}
            min={0}
            max={2000}
            step={10}
          />
          <InputRow
            label="Positive reply rate"
            value={inputs.replyRate}
            onChange={set("replyRate")}
            min={0}
            max={100}
            step={0.5}
            suffix="%"
          />
          <InputRow
            label="Reply → booked call"
            value={inputs.replyToCallRate}
            onChange={set("replyToCallRate")}
            min={0}
            max={100}
            step={5}
            suffix="%"
          />
          <InputRow
            label="Show-up rate"
            value={inputs.showUpRate}
            onChange={set("showUpRate")}
            min={0}
            max={100}
            step={5}
            suffix="%"
          />
          <InputRow
            label="Call → close rate"
            value={inputs.closeRate}
            onChange={set("closeRate")}
            min={0}
            max={100}
            step={5}
            suffix="%"
          />

          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-1 mt-5">
            Business model
          </p>
          <InputRow
            label="Monthly churn rate"
            value={inputs.churnRate}
            onChange={set("churnRate")}
            min={0}
            max={50}
            step={0.5}
            suffix="%"
          />
          <InputRow
            label="Starting MRR"
            value={inputs.startingMRR}
            onChange={set("startingMRR")}
            min={0}
            max={500000}
            step={297}
            prefix="$"
          />
        </div>

        {/* Funnel output */}
        <div className="bg-card border border-border/60 rounded-2xl px-5 py-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-3">
            This month
          </p>

          <div className="space-y-2.5 mb-5">
            {funnelSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground w-36 shrink-0 leading-tight truncate">
                  {step.label}
                </span>
                <div className="flex-1 h-1.5 bg-secondary/60 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary/70 transition-all duration-500"
                    style={{ width: `${Math.min(100, (step.value / maxBar) * 100)}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums text-foreground/80 w-10 text-right shrink-0">
                  {fmtNum(step.value)}
                </span>
              </div>
            ))}
          </div>

          <div className="border-t border-border/40 pt-4 space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">MRR added</span>
              <span className="font-serif text-2xl text-foreground tabular-nums">
                +{fmtMoney(f.mrrAdded)}
              </span>
            </div>
            {f.churnLoss > 0 && (
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">Churn loss</span>
                <span className="text-sm text-muted-foreground tabular-nums">
                  −{fmtMoney(f.churnLoss)}
                </span>
              </div>
            )}
            <div className="flex items-baseline justify-between border-t border-border/40 pt-2 mt-2">
              <span className="text-sm font-medium text-foreground">Net MRR (month 1)</span>
              <span className="font-serif text-2xl text-foreground tabular-nums">
                {fmtMoney(f.endMRR)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 12-month projection */}
      <div className="bg-card border border-border/60 rounded-2xl px-5 py-4">
        <div className="flex items-start justify-between mb-5">
          <div>
            <div className="flex items-center gap-3">
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Projection
              </p>
              <div className="flex gap-0.5">
                {([{ label: "3M", value: 3 }, { label: "1Y", value: 12 }, { label: "2Y", value: 24 }, { label: "3Y", value: 36 }] as const).map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setMonths(t.value)}
                    className={`px-2 py-0.5 rounded-md text-xs font-medium transition-colors ${
                      months === t.value
                        ? "bg-secondary text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="font-serif text-3xl text-foreground tabular-nums mt-0.5">
              {fmtMoney(endMRR)}
            </p>
            <p className="text-xs text-muted-foreground">
              MRR at month {totalMonths}
            </p>
          </div>
          <div className="text-right flex flex-col gap-3 items-end">
            {endMRR > inputs.startingMRR && (
              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  Added
                </p>
                <p className="font-serif text-2xl text-foreground tabular-nums mt-0.5">
                  +{fmtMoney(endMRR - inputs.startingMRR)}
                </p>
              </div>
            )}
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Total collected
              </p>
              <p className="font-serif text-2xl text-foreground tabular-nums mt-0.5">
                {fmtMoney(totalCollected)}
              </p>
            </div>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={chartData} margin={{ top: 4, right: 20, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="mrrGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.2} />
                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="hsl(var(--border))"
              strokeOpacity={0.5}
              vertical={false}
            />
            <XAxis
              dataKey="idx"
              type="number"
              domain={[0, totalMonths]}
              ticks={tickIndices}
              tickFormatter={(i) => chartData[i]?.month ?? ""}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v) => (v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`)}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: "hsl(var(--border))", strokeWidth: 1 }} />
            <Area
              type="monotone"
              dataKey="mrr"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              fill="url(#mrrGrad)"
              dot={isMobile ? { r: 2.5, strokeWidth: 0, fill: "hsl(var(--primary))" } : false}
              activeDot={{ r: 4, strokeWidth: 0, fill: "hsl(var(--primary))" }}
            />
            {chartData.filter((pt) => pt.age !== null).map((pt) => (
              <ReferenceLine
                key={pt.idx}
                x={pt.idx}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="3 4"
                strokeOpacity={0.35}
                label={(props) => {
                  const vb = (props as { viewBox?: { x: number; y: number } }).viewBox;
                  if (!vb) return <></>;
                  return (
                    <text
                      x={vb.x}
                      y={vb.y + 13}
                      textAnchor="middle"
                      fontSize={10}
                      fill="hsl(var(--muted-foreground))"
                      opacity={0.6}
                    >
                      🎂 {pt.age}
                    </text>
                  );
                }}
              />
            ))}
            {MRR_MILESTONES.filter((m) => m.mrr <= endMRR).map((m) => (
              <ReferenceLine
                key={m.mrr}
                y={m.mrr}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="4 4"
                strokeOpacity={0.3}
                label={(props) => {
                  const vb = (props as { viewBox?: { x: number; y: number; width: number } }).viewBox;
                  if (!vb) return <></>;
                  return (
                    <text
                      x={vb.x + vb.width - 4}
                      y={vb.y - 4}
                      textAnchor="end"
                      fontSize={10}
                      fill="hsl(var(--muted-foreground))"
                      opacity={0.55}
                    >
                      {m.label}
                    </text>
                  );
                }}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
