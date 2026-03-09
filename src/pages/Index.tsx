import { Zap, Users, MessageSquare, Clock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "react-router-dom";

const quickLinks = [
  { to: "/pipeline/sales", icon: Zap, label: "Sales Pipeline", desc: "Manage leads & follow-ups" },
  { to: "/pipeline/onboarding", icon: Users, label: "Onboarding", desc: "Track client onboarding" },
  { to: "/messages", icon: MessageSquare, label: "Message Queue", desc: "Pending messages to send" },
  { to: "/settings", icon: Clock, label: "Settings", desc: "Custom values & config" },
];

export default function Index() {
  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto space-y-8 animate-fade-in">
      <div>
        <h1 className="text-3xl font-display font-bold">Dashboard</h1>
        <p className="text-muted-foreground mt-1">Welcome back to Local Scaling CRM</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {quickLinks.map((link) => (
          <Link key={link.to} to={link.to}>
            <Card className="bg-card border-border shadow-card hover:shadow-glow transition-shadow cursor-pointer group">
              <CardContent className="p-5 flex flex-col gap-3">
                <div className="w-10 h-10 rounded-lg bg-accent flex items-center justify-center group-hover:gradient-primary transition-all">
                  <link.icon className="w-5 h-5 text-accent-foreground group-hover:text-primary-foreground" />
                </div>
                <div>
                  <p className="font-display font-semibold">{link.label}</p>
                  <p className="text-xs text-muted-foreground">{link.desc}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      <Card className="bg-card border-border shadow-card">
        <CardContent className="p-6 text-center text-muted-foreground">
          <p className="text-sm">Dashboard stats will populate once you start adding contacts and running automations.</p>
          <p className="text-xs mt-2">Head to <Link to="/settings" className="text-accent-foreground hover:underline">Settings</Link> to configure your custom values first.</p>
        </CardContent>
      </Card>
    </div>
  );
}
