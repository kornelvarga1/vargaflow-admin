import { useState } from "react";
import { useParams } from "react-router-dom";
import { useContacts, SALES_STAGES, ONBOARDING_STAGES } from "@/hooks/useContacts";
import KanbanBoard from "@/components/pipeline/KanbanBoard";
import OutreachBoard from "@/components/outreach/OutreachBoard";
import CSVImportDialog from "@/components/outreach/CSVImportDialog";
import { Button } from "@/components/ui/button";
import { Upload } from "lucide-react";

type Tab = "outreach" | "sales" | "onboarding";

const VALID_TABS: Tab[] = ["outreach", "sales", "onboarding"];

const TAB_LABELS: Record<Tab, string> = {
  outreach: "Outreach",
  sales: "Sales",
  onboarding: "Onboarding",
};

export default function PipelinePage() {
  const { tab: urlTab } = useParams<{ tab?: string }>();
  const initialTab = VALID_TABS.includes(urlTab as Tab) ? (urlTab as Tab) : "outreach";
  const [tab, setTab] = useState<Tab>(initialTab);
  const [importOpen, setImportOpen] = useState(false);

  const { data: outreachContacts = [], isLoading: outreachLoading } = useContacts("Outreach");
  const { data: salesContacts = [], isLoading: salesLoading } = useContacts("Sales");
  const { data: onboardingContacts = [], isLoading: onboardingLoading } = useContacts("Onboarding");

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex shrink-0 px-4 md:px-6 pt-6">
        <div role="tablist" className="inline-flex items-center bg-secondary/60 rounded-full p-0.5">
          {VALID_TABS.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`px-4 py-1.5 text-sm font-medium rounded-full transition-colors ${
                tab === t
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {tab === "outreach" && (
          <div className="px-4 md:px-6 pt-4 pb-4 h-full flex flex-col animate-fade-in overflow-hidden">
            <div className="flex items-center justify-between gap-4 mb-5">
              <div>
                <h1 className="font-serif text-3xl text-foreground">SMS Outreach</h1>
                <p className="text-sm text-muted-foreground mt-1">
                  {outreachContacts.length} contact{outreachContacts.length === 1 ? "" : "s"} in the outreach pipeline
                </p>
              </div>
              <Button onClick={() => setImportOpen(true)}>
                <Upload className="w-4 h-4 mr-1.5" strokeWidth={1.5} /> Import CSV
              </Button>
            </div>
            <OutreachBoard contacts={outreachContacts} isLoading={outreachLoading} />
          </div>
        )}
        {tab === "sales" && (
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
        )}
        {tab === "onboarding" && (
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

      <CSVImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
