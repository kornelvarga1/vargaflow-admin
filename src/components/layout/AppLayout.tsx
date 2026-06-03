import { ReactNode, useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Kanban,
  Settings,
  MessageSquare,
  ListChecks,
  Building2,
  Menu,
  LogOut,
  FileText,
  WifiOff,
  ChevronRight,
  TrendingUp,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { useConversationOpen } from "@/context/ConversationContext";
import { Sheet, SheetContent } from "@/components/ui/sheet";

function OfflineBanner() {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  if (online) return null;
  return (
    <div className="flex items-center justify-center gap-2 bg-amber-500 px-4 py-2 text-sm font-medium text-white shadow-sm">
      <WifiOff className="h-4 w-4 shrink-0" />
      <span>You're offline — data shown may be out of date.</span>
    </div>
  );
}

const allNavItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard", end: true },
  { to: "/messages", icon: MessageSquare, label: "Inbox", end: false },
  { to: "/pipeline", icon: Kanban, label: "Pipeline", end: false },
  { to: "/contacts", icon: Users, label: "Contacts", end: false },
  { to: "/sequences", icon: ListChecks, label: "Sequences", end: false },
  { to: "/clients", icon: Building2, label: "Clients", end: false },
  { to: "/onboarding-submissions", icon: FileText, label: "Submissions", end: false },
  { to: "/growth", icon: TrendingUp, label: "Growth", end: false },
  { to: "/settings", icon: Settings, label: "Settings", end: false },
];

// Mobile primary tabs (4 items in the floating bar) + the rest go in the More sheet
const PRIMARY_COUNT = 4;
const mobilePrimary = allNavItems.slice(0, PRIMARY_COUNT);
const mobileSecondary = allNavItems.slice(PRIMARY_COUNT);

export default function AppLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { isConversationOpen } = useConversationOpen();
  const [sheetOpen, setSheetOpen] = useState(false);

  const handleSignOut = async () => {
    setSheetOpen(false);
    await supabase.auth.signOut();
    navigate("/login");
  };

  const handleSecondaryNav = (to: string) => {
    setSheetOpen(false);
    navigate(to);
  };

  return (
    <div className="flex flex-col h-dvh overflow-hidden bg-background">
      <OfflineBanner />
      <div className="flex flex-1 min-h-0">
        {/* Desktop left rail — icon + label */}
        <aside
          aria-label="Primary"
          className="hidden md:flex w-20 flex-col items-center py-4 gap-0.5 border-r border-border/40 bg-background shrink-0"
        >
          {allNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              aria-label={item.label}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center w-16 py-2 rounded-xl gap-1 transition-colors active-press ${
                  isActive
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }`
              }
            >
              <item.icon className="w-5 h-5" strokeWidth={1.75} />
              <span className="text-[11px] font-medium leading-none">{item.label}</span>
            </NavLink>
          ))}
        </aside>

        <main
          className={
            isConversationOpen
              ? "flex-1 min-h-0 overflow-hidden flex flex-col"
              : "flex-1 min-h-0 overflow-auto pb-32 md:pb-0"
          }
        >
          {children}
        </main>
      </div>

      {/* Mobile floating bar — 4 primary tabs + More button */}
      <nav
        aria-label="Primary"
        className={`md:hidden fixed left-1/2 -translate-x-1/2 z-40 ${isConversationOpen ? "hidden" : "flex"} items-center gap-1 rounded-3xl border border-border/60 glass shadow-float px-2 py-2`}
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 1rem)" }}
      >
        {mobilePrimary.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            aria-label={item.label}
            className={({ isActive }) =>
              `flex items-center gap-2 px-3 py-2 rounded-2xl text-sm font-medium transition-colors active-press ${
                isActive
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`
            }
          >
            {({ isActive }) => (
              <>
                <item.icon className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                <span className={isActive ? "inline" : "hidden"}>{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
        <button
          type="button"
          aria-label="More"
          onClick={() => setSheetOpen(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-2xl text-sm font-medium transition-colors active-press text-muted-foreground hover:text-foreground hover:bg-secondary/50"
        >
          <Menu className="w-4 h-4 shrink-0" strokeWidth={1.75} />
        </button>
      </nav>

      {/* Mobile More sheet — slides from bottom, lists secondary nav + sign out */}
      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent
          side="bottom"
          className="rounded-t-3xl border-border/60 px-4 pt-6 pb-8 max-h-[80vh]"
        >
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground px-2 pb-2">
            More
          </p>
          <div className="rounded-2xl bg-card border border-border/60 divide-y divide-border/40 overflow-hidden">
            {mobileSecondary.map((item) => (
              <button
                key={item.to}
                onClick={() => handleSecondaryNav(item.to)}
                className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-secondary/40 transition-colors text-left active-press"
              >
                <item.icon className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
                <span className="text-sm text-foreground flex-1">{item.label}</span>
                <ChevronRight className="w-4 h-4 text-muted-foreground/60" strokeWidth={1.5} />
              </button>
            ))}
          </div>
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground px-2 pb-2 pt-6">
            Account
          </p>
          <div className="rounded-2xl bg-card border border-border/60 overflow-hidden">
            <button
              onClick={handleSignOut}
              className="w-full flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-secondary/40 transition-colors text-left active-press"
            >
              <span className="text-sm text-foreground">Sign out</span>
              <LogOut className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
