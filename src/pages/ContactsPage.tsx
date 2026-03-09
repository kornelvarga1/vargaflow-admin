import { useState } from "react";
import { useContacts, useDeleteContact, SALES_STAGES, LEAD_SOURCES, type Contact } from "@/hooks/useContacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Plus, Search, MoreHorizontal, Pencil, Trash2, Mail, Phone } from "lucide-react";
import ContactFormDialog from "@/components/contacts/ContactFormDialog";
import { toast } from "sonner";

export default function ContactsPage() {
  const { data: contacts = [], isLoading } = useContacts();
  const deleteContact = useDeleteContact();
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);

  const filtered = contacts.filter(
    (c) =>
      c.full_name.toLowerCase().includes(search.toLowerCase()) ||
      (c.email?.toLowerCase().includes(search.toLowerCase())) ||
      (c.phone?.includes(search))
  );

  const stageLabel = (key: string) => SALES_STAGES.find((s) => s.key === key)?.label || key;

  const handleDelete = async (c: Contact) => {
    try {
      await deleteContact.mutateAsync(c.id);
      toast.success(`${c.full_name} deleted`);
    } catch {
      toast.error("Failed to delete");
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-display font-bold">Contacts</h1>
          <p className="text-sm text-muted-foreground">{contacts.length} total contacts</p>
        </div>
        <Button onClick={() => { setEditing(null); setDialogOpen(true); }}>
          <Plus className="w-4 h-4 mr-1" /> Add Contact
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search contacts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="bg-card border-border animate-pulse h-20" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="p-8 text-center text-muted-foreground">
            {contacts.length === 0
              ? "No contacts yet. Add your first contact to get started."
              : "No contacts match your search."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => (
            <Card key={c.id} className="bg-card border-border hover:border-accent/50 transition-colors">
              <CardContent className="p-4 flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-accent flex items-center justify-center shrink-0">
                  <span className="text-sm font-display font-bold text-accent-foreground">
                    {c.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium font-display truncate">{c.full_name}</p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-0.5">
                    {c.email && (
                      <span className="flex items-center gap-1 truncate">
                        <Mail className="w-3 h-3" /> {c.email}
                      </span>
                    )}
                    {c.phone && (
                      <span className="flex items-center gap-1">
                        <Phone className="w-3 h-3" /> {c.phone}
                      </span>
                    )}
                  </div>
                </div>
                <Badge variant="secondary" className="hidden sm:inline-flex text-xs shrink-0">
                  {c.lead_source}
                </Badge>
                <Badge variant="outline" className="hidden sm:inline-flex text-xs shrink-0 border-accent/40 text-accent-foreground">
                  {stageLabel(c.stage)}
                </Badge>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="shrink-0">
                      <MoreHorizontal className="w-4 h-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => { setEditing(c); setDialogOpen(true); }}>
                      <Pencil className="w-4 h-4 mr-2" /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive" onClick={() => handleDelete(c)}>
                      <Trash2 className="w-4 h-4 mr-2" /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ContactFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        contact={editing}
      />
    </div>
  );
}
