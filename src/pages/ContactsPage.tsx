import { useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useContacts, useDeleteContact, SALES_STAGES, type Contact } from "@/hooks/useContacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Plus, Search, MoreHorizontal, Pencil, Trash2, Phone, MessageSquarePlus, X } from "lucide-react";
import ContactFormDialog from "@/components/contacts/ContactFormDialog";
import EnrollDialog from "@/components/outreach/EnrollDialog";
import { toast } from "sonner";
import { getInitials, getAvatarTone } from "@/lib/initials";

export default function ContactsPage() {
  const navigate = useNavigate();
  const { data: contacts = [], isLoading } = useContacts();
  const deleteContact = useDeleteContact();
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [enrollOpen, setEnrollOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return contacts.filter(
      (c) =>
        c.full_name.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone?.includes(search),
    );
  }, [contacts, search]);

  const groups = useMemo(() => {
    const sorted = [...filtered].sort((a, b) =>
      a.full_name.localeCompare(b.full_name, undefined, { sensitivity: "base" }),
    );
    const map = new Map<string, Contact[]>();
    for (const c of sorted) {
      const initials = getInitials(c.full_name);
      const key = initials ? initials[0] : "#";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allVisibleSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id));
  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filtered.forEach((c) => next.delete(c.id));
      else filtered.forEach((c) => next.add(c.id));
      return next;
    });

  const clearSelection = () => setSelected(new Set());

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
    <div className="px-4 md:px-6 pt-8 max-w-2xl mx-auto animate-fade-in">
      <header className="px-1">
        <h1 className="font-serif text-3xl text-foreground">Contacts</h1>
        <p className="text-sm text-muted-foreground mt-1">{contacts.length} total</p>
      </header>

      <div className="relative mt-6">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
        <Input
          placeholder="Search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-10 text-base bg-secondary/40 border-0 focus-visible:ring-1 focus-visible:ring-ring/50"
        />
      </div>

      {filtered.length > 0 && (
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none mt-4 px-1">
          <Checkbox checked={allVisibleSelected} onCheckedChange={toggleAllVisible} />
          Select all visible
        </label>
      )}

      {selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 bg-secondary/60 rounded-2xl px-4 py-2.5 mt-3">
          <div className="text-sm">
            <span className="font-medium">{selected.size}</span> selected
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setEnrollOpen(true)}>
              <MessageSquarePlus className="w-4 h-4 mr-1" strokeWidth={1.5} />
              Enroll
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              <X className="w-4 h-4" strokeWidth={1.5} />
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3 mt-8">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-card border border-border/40 rounded-2xl animate-pulse h-16" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-12">
          {contacts.length === 0
            ? "No contacts yet. Tap + to add your first."
            : "No contacts match your search."}
        </p>
      ) : (
        <div className="space-y-6 mt-6">
          {groups.map(([letter, items]) => (
            <section key={letter}>
              <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground px-1 pb-2">
                {letter}
              </h2>
              <ul className="bg-card border border-border/60 rounded-2xl divide-y divide-border/40 overflow-hidden">
                {items.map((c) => {
                  const isPhone = /^[+\d]/.test(c.full_name.trim());
                  const isSelected = selected.has(c.id);
                  return (
                    <li key={c.id} className={`flex items-center group ${isSelected ? "bg-secondary/40" : ""}`}>
                      <div onClick={(e) => e.stopPropagation()} className="pl-4 shrink-0">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleOne(c.id)}
                          aria-label={`Select ${c.full_name}`}
                        />
                      </div>
                      <button
                        onClick={() => navigate(`/contacts/${c.id}`)}
                        className="flex-1 flex items-center gap-3 px-3 py-3 text-left hover:bg-secondary/40 transition-colors active-press min-w-0"
                      >
                        <div className={`w-10 h-10 rounded-full ${isPhone ? "bg-secondary" : getAvatarTone(c.full_name)} flex items-center justify-center shrink-0`}>
                          {isPhone ? (
                            <Phone className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
                          ) : (
                            <span className="text-sm font-medium text-white/95">
                              {getInitials(c.full_name)}
                            </span>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[15px] font-medium text-foreground truncate">{c.full_name}</p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5 truncate">
                            {c.phone && <span>{c.phone}</span>}
                            {c.phone && c.stage && <span className="text-muted-foreground/50">·</span>}
                            {c.stage && <span className="truncate">{stageLabel(c.stage)}</span>}
                          </div>
                        </div>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 shrink-0 mr-2 text-muted-foreground opacity-60 hover:opacity-100"
                          >
                            <MoreHorizontal className="w-4 h-4" strokeWidth={1.5} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => { setEditing(c); setDialogOpen(true); }}>
                            <Pencil className="w-4 h-4 mr-2" strokeWidth={1.5} /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive" onClick={() => handleDelete(c)}>
                            <Trash2 className="w-4 h-4 mr-2" strokeWidth={1.5} /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <div className="h-12" />

      {/* FAB — sits above the floating tab bar on mobile, above safe area on desktop */}
      <button
        onClick={() => { setEditing(null); setDialogOpen(true); }}
        aria-label="Add contact"
        className="fixed right-5 z-30 w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-fab flex items-center justify-center active-press hover:brightness-110 transition"
        style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 5.5rem)" }}
      >
        <Plus className="w-6 h-6" strokeWidth={2} />
      </button>

      <ContactFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        contact={editing}
      />

      <EnrollDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        contactIds={[...selected]}
        onEnrolled={clearSelection}
      />
    </div>
  );
}
