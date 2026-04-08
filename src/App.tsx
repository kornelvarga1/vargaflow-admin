import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppLayout from "@/components/layout/AppLayout";
import { ConversationProvider } from "@/context/ConversationContext";
import Index from "./pages/Index";
import SettingsPage from "./pages/SettingsPage";
import ContactsPage from "./pages/ContactsPage";
import SalesPipelinePage from "./pages/SalesPipelinePage";
import OnboardingPipelinePage from "./pages/OnboardingPipelinePage";
import SequencesPage from "./pages/SequencesPage";
import MessageQueuePage from "./pages/MessageQueuePage";
import ContactProfilePage from "./pages/ContactProfilePage";
import ClientsPage from "./pages/ClientsPage";
import LoginPage from "./pages/LoginPage";
import ProtectedRoute from "./components/ProtectedRoute";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="*"
            element={
              <ProtectedRoute>
                <ConversationProvider>
                <AppLayout>
                  <Routes>
                    <Route path="/" element={<Index />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/contacts" element={<ContactsPage />} />
                    <Route path="/pipeline/sales" element={<SalesPipelinePage />} />
                    <Route path="/pipeline/onboarding" element={<OnboardingPipelinePage />} />
                    <Route path="/sequences" element={<SequencesPage />} />
                    <Route path="/messages" element={<MessageQueuePage />} />
                    <Route path="/contacts/:id" element={<ContactProfilePage />} />
                    <Route path="/clients" element={<ClientsPage />} />
                    <Route path="*" element={<NotFound />} />
                  </Routes>
                </AppLayout>
                </ConversationProvider>
              </ProtectedRoute>
            }
          />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
