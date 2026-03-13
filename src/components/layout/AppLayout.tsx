import { ReactNode, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { LayoutDashboard, Users, Kanban, Settings, MessageSquare, Zap, ListChecks, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import logo from "@/assets/logo.png";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "Dashboard" },
  { to: "/pipeline/sales", icon: Kanban, label: "Sales Pipeline" },
  { to: "/pipeline/onboarding", icon: Zap, label: "Onboarding" },
  { to: "/contacts", icon: Users, label: "Contacts" },
  { to: "/sequences", icon: ListChecks, label: "Sequences" },
  { to: "/messages", icon: MessageSquare, label: "Messages" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

// Show max 5 items in bottom nav, rest go in "more" menu
const mobileNavItems = navItems.slice(0, 5);

export default function AppLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-60 flex-col border-r border-border bg-sidebar shrink-0">
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-border">
          <img src={logo} alt="VargaFlow" className="h-9" />
        </div>
        <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? "bg-accent text-accent-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary/70"
                }`
              }
            >
              <item.icon className="w-4 h-4 shrink-0" />
              <span className="truncate">{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="px-5 py-3 border-t border-border">
          <p className="text-[10px] text-muted-foreground/50 font-medium tracking-wider uppercase">VargaFlow</p>
        </div>
      </aside>

      {/* Mobile slide-out menu overlay */}
      {mobileMenuOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-background/60 backdrop-blur-sm"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 bg-sidebar border-r border-border flex flex-col animate-slide-in-right">
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <img src={logo} alt="VargaFlow" className="h-8" />
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMobileMenuOpen(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <nav className="flex-1 px-3 py-3 space-y-0.5">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  onClick={() => setMobileMenuOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-secondary/70"
                    }`
                  }
                >
                  <item.icon className="w-4 h-4 shrink-0" />
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </aside>
        </div>
      )}

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex border-t border-border glass safe-bottom">
        {mobileNavItems.map((item) => {
          const isActive =
            item.to === "/"
              ? location.pathname === "/"
              : location.pathname.startsWith(item.to);
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={`flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-all active-press ${
                isActive ? "text-accent-foreground" : "text-muted-foreground"
              }`}
            >
              <div className={`p-1 rounded-md transition-colors ${isActive ? "bg-accent/50" : ""}`}>
                <item.icon className="w-4 h-4" />
              </div>
              <span>{item.label.split(" ")[0]}</span>
            </NavLink>
          );
        })}
        <button
          onClick={() => setMobileMenuOpen(true)}
          className="flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium text-muted-foreground active-press"
        >
          <div className="p-1">
            <Menu className="w-4 h-4" />
          </div>
          <span>More</span>
        </button>
      </nav>

      {/* Main content */}
      <main className="flex-1 overflow-auto pb-20 md:pb-0">{children}</main>
    </div>
  );
}
