import { useContacts, ONBOARDING_STAGES } from "@/hooks/useContacts";
import KanbanBoard from "@/components/pipeline/KanbanBoard";

export default function OnboardingPipelinePage() {
  const { data: contacts = [], isLoading } = useContacts("Onboarding");

  return (
    <KanbanBoard
      title="Client Onboarding"
      subtitle={`${contacts.length} clients in onboarding`}
      addLabel="Add Client"
      pipeline="Onboarding"
      stages={ONBOARDING_STAGES}
      contacts={contacts}
      isLoading={isLoading}
      defaultAddStage="New Client Waiting for Onboarding Form"
    />
  );
}
