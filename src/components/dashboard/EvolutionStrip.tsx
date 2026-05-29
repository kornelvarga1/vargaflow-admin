import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

const TIERS = [
  {
    emoji: "🐣",
    name: "Penguin chick",
    range: "$0",
    min: 0,
    desc: "Waddling on the ice. Haven't hit the water yet. Everything is still ahead.",
  },
  {
    emoji: "🐧",
    name: "First dive penguin",
    range: "$1–3K MRR",
    min: 1000,
    desc: "First dive, first catch. Still figuring out how to swim straight. But moving.",
  },
  {
    emoji: "🐧🐧",
    name: "Fat healthy penguin",
    range: "$3–6K MRR",
    min: 3000,
    desc: "Back to the colony full, consistently. The hunt works. Do it again.",
  },
  {
    emoji: "🦭",
    name: "Young leopard seal",
    range: "$6–15K MRR",
    min: 6000,
    desc: "Off the penguin diet. Bigger prey now. Starting to own the shoreline.",
  },
  {
    emoji: "🦭💨",
    name: "Full leopard seal",
    range: "$15–30K MRR",
    min: 15000,
    desc: "The shallows are yours. Deliberate, patient, powerful. Nothing scrambles you.",
  },
  {
    emoji: "🐬",
    name: "Dolphin",
    range: "$30–50K MRR",
    min: 30000,
    desc: "Out of the shallows, into open water. Fast, in formation, hunting at range.",
  },
  {
    emoji: "🐋",
    name: "Young orca",
    range: "$50–75K MRR",
    min: 50000,
    desc: "Deep water. Big enough that things move out of the way.",
  },
  {
    emoji: "🐋💨",
    name: "Full orca",
    range: "$75–100K MRR",
    min: 75000,
    desc: "Pod forming. Moving as one. Systematic. Nothing in your lane is safe.",
  },
  {
    emoji: "🐋🐋🐋",
    name: "Orca pod",
    range: "$100K+ MRR",
    min: 100000,
    desc: "Top of the food chain. Coordinated, systematic, unstoppable.",
  },
];

const MRR_KEY = "vf_mrr_k";

export default function EvolutionStrip() {
  const [expanded, setExpanded] = useState(false);
  const [peekIdx, setPeekIdx] = useState<number | null>(null);
  const [mrrK, setMrrK] = useState(() => Number(localStorage.getItem(MRR_KEY) ?? "0"));
  const [inputVal, setInputVal] = useState(() => localStorage.getItem(MRR_KEY) ?? "0");

  const mrr = mrrK * 1000;
  const currentIdx = TIERS.reduce((acc, t, i) => (mrr >= t.min ? i : acc), 0);
  const current = TIERS[currentIdx];

  function handleMrrChange(val: string) {
    setInputVal(val);
    const n = Number(val);
    if (!isNaN(n) && n >= 0) {
      setMrrK(n);
      localStorage.setItem(MRR_KEY, String(n));
    }
  }

  return (
    <div className="mb-5">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center justify-between bg-secondary/40 rounded-xl px-4 py-2.5 hover:bg-secondary/60 transition-colors"
      >
        <span className="flex items-center gap-2.5">
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/40">Status</span>
          <span className="text-base leading-none">{current.emoji}</span>
          <span className="text-xs font-medium text-muted-foreground">{current.name}</span>
        </span>
        {expanded
          ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />}
      </button>

      {expanded && (
        <div className="mt-2 bg-card border border-border/60 rounded-2xl p-4">
          <div className="space-y-0.5">
            {TIERS.map((tier, i) => {
              const isCurrent = i === currentIdx;
              const isPast = i < currentIdx;
              const opacity = 1;
              return (
                <div
                  key={i}
                  className={`flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors ${
                    isCurrent
                      ? "bg-secondary/50"
                      : i === peekIdx
                      ? "bg-secondary/30 cursor-pointer"
                      : "cursor-pointer hover:bg-secondary/20"
                  }`}
                  style={{ opacity }}
                  onClick={() => !isCurrent && setPeekIdx(i === peekIdx ? null : i)}
                >
                  <span className={isCurrent ? "text-2xl leading-none mt-0.5" : "text-sm leading-none mt-1"}>
                    {tier.emoji}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className={`font-medium text-foreground ${isCurrent ? "text-sm" : "text-xs"}`}>
                        {tier.name}
                      </span>
                      <span className="text-[10px] text-muted-foreground">{tier.range}</span>
                    </div>
                    {(isCurrent || i === peekIdx) && (
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{tier.desc}</p>
                    )}
                  </div>
                  {isCurrent && (
                    <div className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-1.5" />
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-4 pt-3.5 border-t border-border/40 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">MRR</span>
            <div className="flex items-center gap-1 bg-secondary/40 rounded-lg px-3 py-1.5">
              <span className="text-xs text-muted-foreground">$</span>
              <input
                type="number"
                value={inputVal}
                min={0}
                onChange={(e) => handleMrrChange(e.target.value)}
                className="w-10 bg-transparent text-sm text-foreground tabular-nums outline-none"
                placeholder="0"
              />
              <span className="text-xs text-muted-foreground">K/mo</span>
            </div>
            <span className="font-serif italic text-sm text-muted-foreground/50">The ocean is abundant.</span>
          </div>
        </div>
      )}
    </div>
  );
}
