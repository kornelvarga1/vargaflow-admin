import { useState } from "react";
import { useContacts, SALES_STAGES, ONBOARDING_STAGES } from "@/hooks/useContacts";
import KanbanBoard from "@/components/pipeline/KanbanBoard";

type Tab = "sales" | "onboarding";

export default function PipelinePage() {
  const [tab, setTab] = useState<Tab>("sales");

  const { data: salesContacts = [], isLoading: salesLoading } = useContacts("Sales");
  const { data: onboardingContacts = [], isLoading: onboardingLoading } = useContacts("Onboarding");

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Tab switcher */}
      <div className="flex shrink-0 border-b border-border px-4 pt-3 gap-1">
        <button
          onClick={() => setTab("sales")}
          className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
            tab === "sales"
              ? "bg-background border border-b-background border-border text-foreground -mb-px"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Sales
        </button>
        <button
          onClick={() => setTab("onboarding")}
          className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
            tab === "onboarding"
              ? "bg-background border border-b-background border-border text-foreground -mb-px"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Onboarding
        </button>
      </div>

      {/* Board */}
      <div className="flex-1 min-h-0">
        {tab === "sales" ? (
          <KanbanBoard
            title="Sales Pipeline"
            subtitle={`${salesContacts.length} contacts in pipeline`}
            addLabel="Add Lead"
            pipeline="Sales"
            stages={SALES_STAGES}
            contacts={salesContacts}
            isLoading={salesLoading}
            defaultAddStage="Lead In"
          />
        ) : (
          <KanbanBoard
            title="Client Onboarding"
            subtitle={`${onboardingContacts.length} clients in onboarding`}
            addLabel="Add Client"
            pipeline="Onboarding"
            stages={ONBOARDING_STAGES}
            contacts={onboardingContacts}
            isLoading={onboardingLoading}
            defaultAddStage="New Client Waiting for Onboarding Form"
          />
        )}
      </div>
    </div>
  );
}
