import { useContacts, SALES_STAGES } from "@/hooks/useContacts";
import KanbanBoard from "@/components/pipeline/KanbanBoard";

export default function SalesPipelinePage() {
  const { data: contacts = [], isLoading } = useContacts("sales");

  return (
    <KanbanBoard
      title="Sales Pipeline"
      subtitle={`${contacts.length} contacts in pipeline`}
      addLabel="Add Lead"
      pipeline="sales"
      stages={SALES_STAGES}
      contacts={contacts}
      isLoading={isLoading}
      defaultAddStage="lead_in"
    />
  );
}
