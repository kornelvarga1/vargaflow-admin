import { useContacts, ONBOARDING_STAGES } from "@/hooks/useContacts";
import KanbanBoard from "@/components/pipeline/KanbanBoard";

export default function OnboardingPipelinePage() {
  const { data: contacts = [], isLoading } = useContacts("onboarding");

  return (
    <KanbanBoard
      title="Client Onboarding"
      subtitle={`${contacts.length} clients in onboarding`}
      addLabel="Add Client"
      pipeline="onboarding"
      stages={ONBOARDING_STAGES}
      contacts={contacts}
      isLoading={isLoading}
      defaultAddStage="intake"
    />
  );
}
