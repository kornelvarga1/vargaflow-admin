import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppLayout from "@/components/layout/AppLayout";
import OnboardingPipelinePage from "./pages/OnboardingPipelinePage";
import Index from "./pages/Index";
import SettingsPage from "./pages/SettingsPage";
import ContactsPage from "./pages/ContactsPage";
import SalesPipelinePage from "./pages/SalesPipelinePage";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Sonner />
      <BrowserRouter>
        <AppLayout>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/contacts" element={<ContactsPage />} />
            <Route path="/pipeline/sales" element={<SalesPipelinePage />} />
            <Route path="/pipeline/onboarding" element={<PlaceholderPage title="Onboarding Pipeline" />} />
            <Route path="/messages" element={<PlaceholderPage title="Message Queue" />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppLayout>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="p-4 md:p-8 animate-fade-in">
      <h1 className="text-2xl font-display font-bold">{title}</h1>
      <p className="text-muted-foreground mt-2">Coming in the next phase.</p>
    </div>
  );
}

export default App;
