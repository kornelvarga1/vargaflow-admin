import { useState } from "react";
import { useContacts, SALES_STAGES, ONBOARDING_STAGES } from "@/hooks/useContacts";
import KanbanBoard from "@/components/pipeline/KanbanBoard";
import OutreachBoard from "@/components/outreach/OutreachBoard";
import CSVImportDialog from "@/components/outreach/CSVImportDialog";
import { Button } from "@/components/ui/button";
import { Upload } from "lucide-react";

type Tab = "outreach" | "sales" | "onboarding";

export default function PipelinePage() {
  const [tab, setTab] = useState<Tab>("outreach");
  const [importOpen, setImportOpen] = useState(false);

  const { data: outreachContacts = [], isLoading: outreachLoading } = useContacts("Outreach");
  const { data: salesContacts = [], isLoading: salesLoading } = useContacts("Sales");
  const { data: onboardingContacts = [], isLoading: onboardingLoading } = useContacts("Onboarding");

  const tabBtn = (key: Tab, label: string) => (
    <button
      onClick={() => setTab(key)}
      className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
        tab === key
          ? "bg-background border border-b-background border-border text-foreground -mb-px"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex shrink-0 border-b border-border px-4 pt-3 gap-1">
        {tabBtn("outreach", "Outreach")}
        {tabBtn("sales", "Sales")}
        {tabBtn("onboarding", "Onboarding")}
      </div>

      <div className="flex-1 min-h-0">
        {tab === "outreach" && (
          <div className="p-4 md:p-6 h-full flex flex-col animate-fade-in overflow-hidden">
            <div className="flex items-center justify-between gap-4 mb-4">
              <div>
                <h1 className="text-2xl font-display font-bold">SMS Outreach</h1>
                <p className="text-sm text-muted-foreground">
                  {outreachContacts.length} contact{outreachContacts.length === 1 ? "" : "s"} in the outreach pipeline
                </p>
              </div>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload className="w-4 h-4 mr-1" /> Import CSV
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
