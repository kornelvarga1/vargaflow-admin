import { useState, useEffect, useRef, useMemo } from "react";
import { Link, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { invokeFunction } from "@/lib/invokeFunction";
import { ADMIN_BUSINESS_ID } from "@/lib/constants";
import { useCustomValues, replaceCustomValues } from "@/hooks/useCustomValues";
import { SALES_STAGES, ONBOARDING_STAGES } from "@/hooks/useContacts";
import { useConversationOpen } from "@/context/ConversationContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  MessageSquare,
  Loader2,
  Search,
  ArrowLeft,
  ArrowUp,
  Zap,
  Phone,
} from "lucide-react";
import { toast } from "sonner";
import { format, formatDistanceToNow } from "date-fns";
import { getInitials, getAvatarTone } from "@/lib/initials";

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

  useEffect(() => {
    setOptimisticMessages([]);
  }, [selectedContactId]);

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
      <div className={`flex flex-col border-border/40 shrink-0 w-full md:w-80 lg:w-96 md:border-r ${selectedContactId ? "hidden md:flex" : "flex"}`}>

        {/* Header: title + segmented control inline, search below */}
        <div className="px-4 pt-8 pb-3 shrink-0">
          <div className="flex items-center justify-between gap-3 mb-4">
            <h1 className="font-serif text-3xl text-foreground">Messages</h1>
            <div role="tablist" className="inline-flex items-center bg-secondary/60 rounded-full p-0.5">
              {(["all", "unread"] as FilterType[]).map((f) => (
                <button
                  key={f}
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                    filter === f
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {f === "all" ? "All" : "Unread"}
                </button>
              ))}
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
            <Input
              placeholder="Search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-10 text-base bg-secondary/40 border-0 focus-visible:ring-1 focus-visible:ring-ring/50"
            />
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
              {filteredContacts.map((c) => {
                const name = c.full_name.trim();
                const isPhone = !name || /^[+\d]/.test(name);
                const isUnread = c.hasUnread && !seenIds.has(c.id);
                return (
                  <button
                    key={c.id}
                    className={`w-full text-left px-4 py-3 flex items-center gap-3 overflow-x-hidden hover:bg-secondary/40 active:bg-secondary transition-colors ${
                      selectedContactId === c.id ? "bg-secondary/60" : ""
                    }`}
                    onClick={() => selectContact(c.id)}
                  >
                    <div className={`w-11 h-11 rounded-full ${isPhone ? "bg-secondary" : getAvatarTone(name)} flex items-center justify-center shrink-0`}>
                      {isPhone ? (
                        <Phone className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
                      ) : (
                        <span className="text-sm font-medium text-white/95">
                          {getInitials(name)}
                        </span>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 overflow-hidden max-w-full">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className={`text-[15px] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${isUnread ? "font-semibold text-foreground" : "font-medium text-foreground"}`}>
                          {c.full_name}
                        </p>
                        <span className="text-xs text-muted-foreground shrink-0">
                          {formatDistanceToNow(new Date(c.lastMessageAt), { addSuffix: false })}
                        </span>
                      </div>
                      <p className={`text-sm min-w-0 overflow-hidden text-ellipsis whitespace-nowrap mt-0.5 ${isUnread ? "text-foreground/90" : "text-muted-foreground"}`}>
                        {c.lastMessage}
                      </p>
                    </div>
                    {isUnread && (
                      <div className="w-2 h-2 rounded-full bg-primary shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right Panel: Conversation */}
      <div className={
        selectedContactId
          ? "fixed inset-x-0 top-0 h-dvh flex flex-col overflow-hidden bg-background z-20 md:static md:flex-1 md:h-auto md:inset-auto md:z-auto"
          : "hidden md:flex md:flex-col md:flex-1 md:min-w-0"
      }>
        {!selectedContactId ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground text-base">
            <div className="text-center">
              <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-30" strokeWidth={1.5} />
              <p>Select a contact to view conversation</p>
            </div>
          </div>
        ) : (
          <>
            {/* Conversation Header */}
            {selectedContact && (() => {
              const headerName = selectedContact.full_name.trim();
              const headerIsPhone = !headerName || /^[+\d]/.test(headerName);
              return (
                <div className="sticky top-0 z-10 px-3 py-2.5 border-b border-border/40 bg-background/95 backdrop-blur space-y-1.5 shrink-0">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="md:hidden shrink-0 -ml-1 h-9 w-9"
                      onClick={() => setSelectedContactId(null)}
                    >
                      <ArrowLeft className="w-5 h-5" strokeWidth={1.5} />
                    </Button>
                    <Link
                      to={`/contacts/${selectedContact.id}`}
                      className="flex items-center gap-2 flex-1 min-w-0 px-1 py-1 rounded-lg hover:bg-secondary/40 transition-colors"
                    >
                      <div className={`w-9 h-9 rounded-full ${headerIsPhone ? "bg-secondary" : getAvatarTone(headerName)} flex items-center justify-center shrink-0`}>
                        {headerIsPhone ? (
                          <Phone className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
                        ) : (
                          <span className="text-xs font-medium text-white/95">
                            {getInitials(headerName)}
                          </span>
                        )}
                      </div>
                      <p className="font-semibold text-[15px] flex-1 truncate text-foreground">{selectedContact.full_name}</p>
                    </Link>
                    {selectedContact.phone && (
                      <a href={`tel:${selectedContact.phone}`} className="shrink-0">
                        <Button variant="ghost" size="icon" className="h-9 w-9">
                          <Phone className="w-4 h-4" strokeWidth={1.5} />
                        </Button>
                      </a>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap pl-1">
                    <Badge variant="outline" className="text-xs border-border/60 text-muted-foreground font-normal">
                      {selectedContact.pipeline === "Onboarding" ? "Onboarding" : "Sales"}
                    </Badge>
                    <Badge variant="outline" className="text-xs border-border/60 text-muted-foreground font-normal">
                      {stageLabel(selectedContact.stage, selectedContact.pipeline)}
                    </Badge>
                    {activeSeq && (
                      <Badge variant="outline" className="text-xs gap-1 border-border/60 text-muted-foreground font-normal">
                        <Zap className="w-3 h-3 text-muted-foreground" strokeWidth={1.5} />
                        {(activeSeq as any).sequences?.name || "Sequence"} — Step {activeSeq.current_step}
                      </Badge>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Messages — with timestamp clusters at > 5min gaps */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 space-y-1.5">
              {msgsLoading ? (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : allMessages.length === 0 ? (
                <div className="flex items-center justify-center h-full text-base text-muted-foreground">
                  No messages yet.
                </div>
              ) : (
                (() => {
                  const elements: React.ReactNode[] = [];
                  let lastTime: number | null = null;
                  for (const msg of allMessages) {
                    const t = new Date(msg.sent_at || msg.scheduled_at).getTime();
                    if (lastTime === null || t - lastTime > 5 * 60 * 1000) {
                      elements.push(
                        <div
                          key={`sep-${msg.id}`}
                          className="text-center text-[11px] text-muted-foreground py-2 select-none"
                        >
                          {format(new Date(t), "MMM d · h:mm a")}
                        </div>
                      );
                    }
                    elements.push(<MessageBubble key={msg.id} message={msg} />);
                    lastTime = t;
                  }
                  return elements;
                })()
              )}
            </div>

            {/* Compose */}
            <div className="flex-none" style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 0.5rem)" }}>
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
        className={`max-w-[72%] rounded-3xl px-3.5 py-2.5 ${
          isOutbound
            ? "bg-secondary text-foreground rounded-br-lg"
            : "bg-[var(--bubble-in-bg)] text-[var(--bubble-in-text)] rounded-bl-lg"
        } ${isCancelled ? "opacity-50 line-through" : ""} ${isPending && isOutbound ? "opacity-60" : ""}`}
        title={format(new Date(message.sent_at || message.scheduled_at), "MMM d, yyyy · h:mm a")}
      >
        <p className="text-[15px] leading-[1.45] whitespace-pre-wrap">
          {renderMessageContent(
            message.message_content,
            "underline underline-offset-2 text-foreground"
          )}
        </p>
        {isPending && (
          <div className="flex items-center mt-1">
            <Badge variant="outline" className="text-[10px] h-4 border-border/60 text-muted-foreground font-normal">
              Pending
            </Badge>
          </div>
        )}
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

      const businessId = contactData?.business_id ?? ADMIN_BUSINESS_ID;

      const { data, error } = await invokeFunction<{ error?: string }>("send-manual-sms", {
        contact_id: contactId,
        business_id: businessId,
        message: content,
        to_phone: contactPhone,
      });

      if (error || data?.error) {
        onOptimisticRollback(scheduledAt);
        setText(content);
        throw new Error(data?.error ?? error?.message ?? "Send failed");
      }

      onSent();
    } catch {
      toast.error("Failed to send message");
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
    <div className="px-3 py-2 border-t border-border/40 bg-background shrink-0">
      {/* Mobile: separated slim bar + bigger button beside */}
      <div className="md:hidden flex items-end gap-2">
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
          className="flex-1 resize-none rounded-full border border-input bg-background px-4 py-1.5 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring min-h-[36px] max-h-[120px]"
          rows={1}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!text.trim() || sending}
          aria-label="Send"
          className={`shrink-0 h-10 w-10 rounded-full flex items-center justify-center transition-colors disabled:opacity-100 ${
            text.trim()
              ? "bg-primary text-primary-foreground hover:brightness-110"
              : "bg-secondary text-muted-foreground"
          }`}
        >
          {sending ? (
            <Loader2 className="w-5 h-5 animate-spin" strokeWidth={2} />
          ) : (
            <ArrowUp className="w-5 h-5" strokeWidth={2.25} />
          )}
        </button>
      </div>

      {/* Desktop: unified rounded-full pill with button inside */}
      <div className="hidden md:block relative rounded-full border border-input bg-background focus-within:ring-2 focus-within:ring-ring transition-shadow">
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
          className="block w-full resize-none bg-transparent pl-5 pr-12 py-2.5 text-base placeholder:text-muted-foreground focus:outline-none min-h-[44px] max-h-[120px]"
          rows={1}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!text.trim() || sending}
          aria-label="Send"
          className={`absolute right-1 bottom-1 h-9 w-9 rounded-full flex items-center justify-center transition-colors disabled:opacity-100 ${
            text.trim()
              ? "bg-primary text-primary-foreground hover:brightness-110"
              : "bg-secondary text-muted-foreground"
          }`}
        >
          {sending ? (
            <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2} />
          ) : (
            <ArrowUp className="w-4 h-4" strokeWidth={2.25} />
          )}
        </button>
      </div>
    </div>
  );
}
