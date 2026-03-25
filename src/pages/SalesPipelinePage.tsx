import { useContacts, SALES_STAGES } from "@/hooks/useContacts";
import KanbanBoard from "@/components/pipeline/KanbanBoard";

export default function SalesPipelinePage() {
  const { data: contacts = [], isLoading } = useContacts("Sales");

  return (
    <KanbanBoard
      title="Sales Pipeline"
      subtitle={`${contacts.length} contacts in pipeline`}
      addLabel="Add Lead"
      pipeline="Sales"
      stages={SALES_STAGES}
      contacts={contacts}
      isLoading={isLoading}
      defaultAddStage="Lead In"
    />
  );
}
