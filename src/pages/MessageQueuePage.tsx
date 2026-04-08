import { useState, useEffect, useRef, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCustomValues, replaceCustomValues } from "@/hooks/useCustomValues";
import { logActivity } from "@/hooks/useActivityLog";
import { SALES_STAGES, ONBOARDING_STAGES } from "@/hooks/useContacts";
import { useConversationOpen } from "@/context/ConversationContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageSquare,
  Send,
  Loader2,
  Search,
  ArrowLeft,
  ArrowRight,
  Zap,
  Phone,
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";

const ALL_STAGES = [
  ...SALES_STAGES.map((s) => ({ ...s, pipeline: "Sales" })),
  ...ONBOARDING_STAGES.map((s) => ({ ...s, pipeline: "Onboarding" })),
];

type ConversationContact = {
  id: string;
  full_name: string;
  phone: string | null;
  pipeline: string;
  stage: string;
  lastMessage: string;
  lastMessageAt: string;
  hasUnread: boolean;
  messageCount: number;
};

type Message = {
  id: string;
  message_content: string;
  message_type: string;
  status: string;
  scheduled_at: string;
  sent_at: string | null;
  created_at: string;
  direction: "outbound" | "inbound";
};

// --- Hooks ---

function useConversationContacts() {
  return useQuery({
    queryKey: ["conversation_contacts"],
    queryFn: async () => {
      const { data: messages, error } = await supabase
        .from("message_queue")
        .select("contact_id, message_content, scheduled_at, sent_at, status, message_type, created_at, direction")
        .is("business_id", null)
        .in("status", ["sent", "received"])
        .order("scheduled_at", { ascending: false })
        .limit(500);

      if (error) throw error;

      const contactIds = [...new Set((messages || []).map((m) => m.contact_id).filter((id): id is string => id !== null))];
      if (contactIds.length === 0) return [];

      const { data: contacts, error: contactsError } = await supabase
        .from("contacts")
        .select("id, full_name, phone, pipeline, stage, last_read_at")
        .is("business_id", null)
        .in("id", contactIds);

      if (contactsError) throw contactsError;
      if (!contacts || contacts.length === 0) return [];

      const contactMap = new Map(contacts.map((c) => [c.id, c]));
      const convos: ConversationContact[] = [];

      const groupedByContact = new Map<string, typeof messages>();
      for (const msg of messages || []) {
        if (!groupedByContact.has(msg.contact_id)) {
          groupedByContact.set(msg.contact_id, []);
        }
        groupedByContact.get(msg.contact_id)!.push(msg);
      }

      for (const [contactId, msgs] of groupedByContact) {
        const contact = contactMap.get(contactId);
        if (!contact) continue;

        const latest = msgs[0];
        convos.push({
          id: contact.id,
          full_name: contact.full_name,
          phone: contact.phone,
          pipeline: contact.pipeline,
          stage: contact.stage,
          lastMessage: (latest.direction === "outbound" ? "You: " : "") + latest.message_content,
          lastMessageAt: latest.sent_at || latest.scheduled_at,
          hasUnread: msgs.some(
            (m) =>
              m.direction === "inbound" &&
              m.status === "received" &&
              (!contact.last_read_at || new Date(m.created_at) > new Date(contact.last_read_at))
          ),
          messageCount: msgs.length,
        });
      }

      convos.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
      return convos;
    },
    refetchInterval: 15000,
  });
}

function useConversation(contactId: string | null) {
  const { data: customValues = [] } = useCustomValues();

  return useQuery({
    queryKey: ["conversation", contactId],
    enabled: !!contactId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("message_queue")
        .select("*")
        .eq("contact_id", contactId!)
        .in("status", ["sent", "received"])
        .order("scheduled_at", { ascending: true });

      if (error) throw error;

      const { data: contact } = await supabase
        .from("contacts")
        .select("full_name")
        .eq("id", contactId!)
        .single();

      const contactName = contact?.full_name || "Unknown";

      return (data || [])
        .map((msg) => ({
          id: msg.id,
          message_content: replaceCustomValues(
            msg.message_content.replace(/\{\{contact_name\}\}/g, contactName),
            customValues
          ),
          message_type: msg.message_type,
          status: msg.status,
          scheduled_at: msg.scheduled_at,
          sent_at: msg.sent_at,
          created_at: msg.created_at,
          direction: (msg.direction ?? "outbound") as "outbound" | "inbound",
        }))
        .sort((a, b) => {
          const tA = new Date(a.sent_at ?? a.scheduled_at).getTime();
          const tB = new Date(b.sent_at ?? b.scheduled_at).getTime();
          return tA - tB;
        }) as Message[];
    },
    refetchInterval: 10000,
  });
}

function useContactActiveSequence(contactId: string | null) {
  return useQuery({
    queryKey: ["contact_seq_banner", contactId],
    enabled: !!contactId,
    queryFn: async () => {
      const { data } = await supabase
        .from("contact_sequences")
        .select("status, current_step, sequences(name)")
        .eq("contact_id", contactId!)
        .eq("status", "active")
        .limit(1)
        .maybeSingle();
      return data;
    },
  });
}

type FilterType = "all" | "unread";

// --- Main Component ---

export default function MessageQueuePage() {
  const location = useLocation();
  const [selectedContactId, setSelectedContactId] = useState<string | null>(
    (location.state as { contactId?: string } | null)?.contactId ?? null
  );
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const qc = useQueryClient();

  const { data: contacts = [], isLoading: contactsLoading } = useConversationContacts();
  const { data: messages = [], isLoading: msgsLoading } = useConversation(selectedContactId);
  const { data: activeSeq } = useContactActiveSequence(selectedContactId);
  const [optimisticMessages, setOptimisticMessages] = useState<Message[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { setConversationOpen } = useConversationOpen();

  const selectContact = (id: string) => {
    setSelectedContactId(id);
    setSeenIds((prev) => new Set([...prev, id]));
    supabase.from("contacts").update({ last_read_at: new Date().toISOString() }).eq("id", id).then(() => {
      qc.invalidateQueries({ queryKey: ["conversation_contacts"] });
    });
  };

  useEffect(() => {
    setConversationOpen(!!selectedContactId);
    return () => setConversationOpen(false);
  }, [selectedContactId, setConversationOpen]);

  // Clear optimistic messages when switching contacts
  useEffect(() => {
    setOptimisticMessages([]);
  }, [selectedContactId]);

  // Prune optimistic messages whose real counterpart has arrived
  useEffect(() => {
    if (optimisticMessages.length === 0 || messages.length === 0) return;
    setOptimisticMessages((prev) =>
      prev.filter((opt) => {
        const optTime = new Date(opt.scheduled_at).getTime();
        return !messages.some(
          (real) =>
            real.direction === "outbound" &&
            real.message_content === opt.message_content &&
            Math.abs(new Date(real.scheduled_at).getTime() - optTime) < 5000
        );
      })
    );
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  const allMessages = useMemo(() => {
    const dedupedOptimistic = optimisticMessages.filter(
      (opt) =>
        !messages.some(
          (real) =>
            real.direction === "outbound" &&
            real.message_content === opt.message_content &&
            Math.abs(
              new Date(real.scheduled_at).getTime() - new Date(opt.scheduled_at).getTime()
            ) < 5000
        )
    );
    return [...messages, ...dedupedOptimistic].sort((a, b) => {
      const tA = new Date(a.sent_at ?? a.scheduled_at).getTime();
      const tB = new Date(b.sent_at ?? b.scheduled_at).getTime();
      return tA - tB;
    });
  }, [messages, optimisticMessages]);

  const selectedContact = contacts.find((c) => c.id === selectedContactId);

  const filteredContacts = contacts.filter((c) => {
    if (search && !c.full_name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "unread") return c.hasUnread && !seenIds.has(c.id);
    return true;
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [allMessages]);

  // Auto-select first contact on desktop only
  useEffect(() => {
    if (!selectedContactId && contacts.length > 0 && window.innerWidth >= 768) {
      setSelectedContactId(contacts[0].id);
    }
  }, [contacts, selectedContactId]);

  const stageLabel = (key: string, pipeline: string) =>
    ALL_STAGES.find((s) => s.key === key && s.pipeline === pipeline)?.label || key;

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden animate-fade-in">
      {/* Left Panel: Contact List */}
      <div className={`flex flex-col border-border shrink-0 w-full md:w-80 lg:w-96 md:border-r ${selectedContactId ? "hidden md:flex" : "flex"}`}>

        {/* Mobile header */}
        <div className="px-4 py-3 border-b border-border shrink-0 md:hidden">
          <h1 className="text-xl font-display font-bold flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-primary" />
            Messages
          </h1>
        </div>

        {/* Search + Filter */}
        <div className="px-4 py-3 space-y-2 border-b border-border shrink-0">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search contacts..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-10 text-base"
            />
          </div>
          <div className="flex gap-1">
            {(["all", "unread"] as FilterType[]).map((f) => (
              <Button
                key={f}
                variant={filter === f ? "default" : "ghost"}
                size="sm"
                className="h-8 text-sm flex-1"
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : "Unread"}
              </Button>
            ))}
          </div>
        </div>

        {/* Contact List */}
        <div className="flex-1 overflow-y-auto">
          {contactsLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : filteredContacts.length === 0 ? (
            <div className="p-6 text-center text-base text-muted-foreground">
              {contacts.length === 0
                ? "No conversations yet. Messages will appear when you send SMS to contacts."
                : "No conversations match your filter."}
            </div>
          ) : (
            <div className="pb-4">
              {filteredContacts.map((c) => (
                <button
                  key={c.id}
                  className={`w-full text-left px-4 py-4 flex items-center gap-3 overflow-x-hidden hover:bg-secondary/50 active:bg-secondary transition-colors border-b border-border/50 ${
                    selectedContactId === c.id ? "bg-secondary" : ""
                  }`}
                  onClick={() => selectContact(c.id)}
                >
                  <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    {(() => {
                      const name = c.full_name.trim();
                      const isPhone = !name || /^[+\d]/.test(name);
                      return isPhone ? (
                        <Phone className="w-5 h-5 text-primary" />
                      ) : (
                        <span className="text-sm font-display font-bold text-primary">
                          {name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                        </span>
                      );
                    })()}
                  </div>
                  <div className="flex-1 min-w-0 overflow-hidden max-w-full">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className={`text-base min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${c.hasUnread && !seenIds.has(c.id) ? "font-bold" : "font-semibold"}`}>
                        {c.full_name}
                      </p>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatDistanceToNow(new Date(c.lastMessageAt), { addSuffix: false })}
                      </span>
                    </div>
                    <p className={`text-sm min-w-0 overflow-hidden text-ellipsis whitespace-nowrap mt-0.5 ${c.hasUnread && !seenIds.has(c.id) ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                      {c.lastMessage}
                    </p>
                  </div>
                  {c.hasUnread && !seenIds.has(c.id) && (
                    <div className="w-2.5 h-2.5 rounded-full bg-primary shrink-0" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel: Conversation
          Mobile open:   fixed full-screen overlay above everything
          Mobile closed: hidden
          Desktop:       flex-1, sits beside the left panel */}
      <div className={
        selectedContactId
          ? "fixed inset-x-0 top-0 h-dvh flex flex-col overflow-hidden bg-background z-20 md:static md:flex-1 md:h-auto md:inset-auto md:z-auto"
          : "hidden md:flex md:flex-col md:flex-1 md:min-w-0"
      }>
        {!selectedContactId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-base">
            <div className="text-center">
              <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>Select a contact to view conversation</p>
            </div>
          </div>
        ) : (
          <>
            {/* Conversation Header */}
            {selectedContact && (
              <div className="sticky top-0 z-10 px-3 py-2.5 border-b border-border bg-secondary/20 space-y-1.5 shrink-0">
                {/* Row 1: back + avatar + name + call + profile */}
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="md:hidden shrink-0 -ml-1 h-9 w-9"
                    onClick={() => setSelectedContactId(null)}
                  >
                    <ArrowLeft className="w-5 h-5" />
                  </Button>
                  <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                    {(() => {
                      const name = selectedContact.full_name.trim();
                      const isPhone = !name || /^[+\d]/.test(name);
                      return isPhone ? (
                        <Phone className="w-4 h-4 text-primary" />
                      ) : (
                        <span className="text-xs font-display font-bold text-primary">
                          {name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                        </span>
                      );
                    })()}
                  </div>
                  <p className="font-display font-semibold text-base flex-1 truncate">{selectedContact.full_name}</p>
                  {selectedContact.phone && (
                    <a href={`tel:${selectedContact.phone}`} className="shrink-0">
                      <Button variant="ghost" size="icon" className="h-9 w-9">
                        <Phone className="w-4 h-4" />
                      </Button>
                    </a>
                  )}
                  <Link to={`/contacts/${selectedContact.id}`} className="shrink-0">
                    <Button variant="ghost" size="icon" className="h-9 w-9">
                      <ArrowRight className="w-4 h-4" />
                    </Button>
                  </Link>
                </div>
                {/* Row 2: badges */}
                <div className="flex items-center gap-1.5 flex-wrap pl-1">
                  <Badge variant="outline" className="text-xs border-primary/40 text-primary">
                    {selectedContact.pipeline === "Onboarding" ? "Onboarding" : "Sales"}
                  </Badge>
                  <Badge variant="secondary" className="text-xs">
                    {stageLabel(selectedContact.stage, selectedContact.pipeline)}
                  </Badge>
                  {activeSeq && (
                    <Badge variant="default" className="text-xs">
                      <Zap className="w-3 h-3 mr-0.5" />
                      {(activeSeq as any).sequences?.name || "Sequence"} — Step {activeSeq.current_step}
                    </Badge>
                  )}
                </div>
              </div>
            )}

            {/* Messages */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 space-y-2">
              {msgsLoading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : allMessages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-base text-muted-foreground">
                  No messages yet.
                </div>
              ) : (
                allMessages.map((msg) => <MessageBubble key={msg.id} message={msg} />)
              )}
            </div>

            {/* Compose */}
            <div className="flex-none" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
              <ComposeBar
                contactId={selectedContactId}
                contactName={selectedContact?.full_name || ""}
                contactPhone={selectedContact?.phone || null}
                onSent={() => {
                  qc.invalidateQueries({ queryKey: ["conversation", selectedContactId] });
                  qc.invalidateQueries({ queryKey: ["conversation_contacts"] });
                }}
                onOptimisticMessage={(msg) => setOptimisticMessages((prev) => [...prev, msg])}
                onOptimisticRollback={(scheduledAt) =>
                  setOptimisticMessages((prev) => prev.filter((m) => m.scheduled_at !== scheduledAt))
                }
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// --- URL renderer ---

function renderMessageContent(text: string, linkClass: string) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, i) =>
    urlRegex.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className={linkClass}>
        View link
      </a>
    ) : (
      part
    )
  );
}

// --- Message Bubble ---

function MessageBubble({ message }: { message: Message }) {
  const isOutbound = message.direction === "outbound";
  const isPending = message.status === "pending";
  const isCancelled = message.status === "cancelled";

  return (
    <div className={`flex ${isOutbound ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[82%] rounded-3xl px-4 py-3 ${
          isOutbound
            ? "bg-primary text-primary-foreground rounded-br-lg"
            : "bg-[var(--bubble-in-bg)] text-[var(--bubble-in-text)] rounded-bl-lg"
        } ${isCancelled ? "opacity-50 line-through" : ""} ${isPending && isOutbound ? "opacity-60" : ""}`}
      >
        <p className="text-base leading-relaxed whitespace-pre-wrap">
          {renderMessageContent(
            message.message_content,
            isOutbound
              ? "underline underline-offset-2 opacity-80"
              : "underline underline-offset-2 text-primary"
          )}
        </p>
        <div className={`flex items-center gap-1.5 mt-1.5 ${
          isOutbound ? "text-primary-foreground/60" : "text-muted-foreground"
        }`}>
          <span className="text-xs">
            {format(new Date(message.sent_at || message.scheduled_at), "MMM d, h:mm a")}
          </span>
          {isPending && (
            <Badge variant="outline" className="text-[10px] h-4 border-primary-foreground/30 text-primary-foreground/60">
              Pending
            </Badge>
          )}
          {message.status === "sent" && <span className="text-xs">✓</span>}
        </div>
      </div>
    </div>
  );
}

// --- Compose Bar ---

function ComposeBar({
  contactId,
  contactName,
  contactPhone,
  onSent,
  onOptimisticMessage,
  onOptimisticRollback,
}: {
  contactId: string;
  contactName: string;
  contactPhone: string | null;
  onSent: () => void;
  onOptimisticMessage: (msg: Message) => void;
  onOptimisticRollback: (scheduledAt: string) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!text.trim()) return;
    setSending(true);

    const content = text.trim();
    const scheduledAt = new Date().toISOString();

    onOptimisticMessage({
      id: `optimistic-${scheduledAt}`,
      message_content: content,
      message_type: "sms",
      status: "pending",
      scheduled_at: scheduledAt,
      sent_at: null,
      created_at: scheduledAt,
      direction: "outbound",
    });
    setText("");

    try {
      const { data: contactData } = await supabase
        .from("contacts")
        .select("business_id")
        .eq("id", contactId)
        .single();

      const { error } = await supabase.from("message_queue").insert({
        contact_id: contactId,
        message_content: content,
        message_type: "sms",
        scheduled_at: scheduledAt,
        status: "pending",
        to_phone: contactPhone,
        business_id: contactData?.business_id ?? null,
        metadata: { to: contactPhone },
      });

      if (error) {
        onOptimisticRollback(scheduledAt);
        setText(content);
        throw error;
      }

      await logActivity("message_queued", `Manual SMS queued: "${content.slice(0, 60)}"`, contactId);
      toast.success("Message queued", {
        description: contactPhone ? `To ${contactPhone}` : "No phone number on file",
      });
      onSent();
    } catch {
      toast.error("Failed to queue message");
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="px-3 py-3 border-t border-border bg-card shrink-0">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${contactName}...`}
          inputMode="text"
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-form-type="other"
          className="flex-1 resize-none rounded-2xl border border-input bg-background px-4 py-3 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring min-h-[48px] max-h-[140px]"
          rows={1}
        />
        <Button
          onClick={handleSend}
          disabled={!text.trim() || sending}
          className="shrink-0 h-12 w-12 rounded-full"
          size="icon"
        >
          {sending ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            <Send className="w-5 h-5" />
          )}
        </Button>
      </div>
    </div>
  );
}
