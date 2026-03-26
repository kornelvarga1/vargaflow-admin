import { useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useCustomValues, replaceCustomValues } from "@/hooks/useCustomValues";
import { logActivity } from "@/hooks/useActivityLog";
import { SALES_STAGES, ONBOARDING_STAGES } from "@/hooks/useContacts";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  MessageSquare,
  Send,
  Loader2,
  Search,
  User,
  ArrowRight,
  Zap,
  Copy,
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
      // Get distinct contacts that have messages, with their latest message
      // Use RPC-style: fetch contacts that have messages, ordered by latest message
      const { data: contacts, error: contactsError } = await supabase
        .from("contacts")
        .select("id, full_name, phone, pipeline, stage, business_id")
        .is("business_id", null);
      if (contactsError) throw contactsError;
      if (!contacts || contacts.length === 0) return [];

      const contactIds = contacts.map((c) => c.id);

      // Fetch only the most recent message per contact by getting
      // a limited set ordered desc and deduping client-side
      const { data: recentMessages, error } = await supabase
        .from("message_queue")
        .select("contact_id, message_content, scheduled_at, sent_at, status")
        .in("contact_id", contactIds)
        .order("scheduled_at", { ascending: false })
        .limit(500);

      if (error) throw error;

      // Build latest-per-contact map
      const latestByContact = new Map<string, typeof recentMessages[0]>();
      for (const msg of recentMessages || []) {
        if (!latestByContact.has(msg.contact_id)) {
          latestByContact.set(msg.contact_id, msg);
        }
      }

      // Only include contacts that have messages
      const contactMap = new Map(contacts.map((c) => [c.id, c]));
      const convos: ConversationContact[] = [];

      for (const [contactId, latest] of latestByContact) {
        const contact = contactMap.get(contactId);
        if (!contact) continue;

        convos.push({
          id: contact.id,
          full_name: contact.full_name,
          phone: contact.phone,
          pipeline: contact.pipeline,
          stage: contact.stage,
          lastMessage: latest.message_content.slice(0, 60) + (latest.message_content.length > 60 ? "…" : ""),
          lastMessageAt: latest.sent_at || latest.scheduled_at,
          hasUnread: false,
          messageCount: 0,
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
        .order("scheduled_at", { ascending: true });

      if (error) throw error;

      // Get contact name for template resolution
      const { data: contact } = await supabase
        .from("contacts")
        .select("full_name")
        .eq("id", contactId!)
        .single();

      const contactName = contact?.full_name || "Unknown";

      return (data || []).map((msg) => ({
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
        direction: "outbound" as const, // All current messages are outbound
      })) as Message[];
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

// --- Filter type ---
type FilterType = "all" | "unread" | "sent";

// --- Main Component ---

export default function MessageQueuePage() {
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterType>("all");
  const { data: contacts = [], isLoading: contactsLoading } = useConversationContacts();
  const { data: messages = [], isLoading: msgsLoading } = useConversation(selectedContactId);
  const { data: activeSeq } = useContactActiveSequence(selectedContactId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const selectedContact = contacts.find((c) => c.id === selectedContactId);

  // Filter contacts
  const filteredContacts = contacts.filter((c) => {
    if (search && !c.full_name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === "unread") return c.hasUnread;
    return true;
  });

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Auto-select first contact
  useEffect(() => {
    if (!selectedContactId && contacts.length > 0) {
      setSelectedContactId(contacts[0].id);
    }
  }, [contacts, selectedContactId]);

  const stageLabel = (key: string, pipeline: string) =>
    ALL_STAGES.find((s) => s.key === key && s.pipeline === pipeline)?.label || key;

  return (
    <div className="h-[calc(100vh-4rem)] flex flex-col animate-fade-in">
      {/* Header */}
      <div className="p-4 md:px-6 border-b border-border shrink-0">
        <h1 className="text-2xl font-display font-bold flex items-center gap-2">
          <MessageSquare className="w-6 h-6 text-primary" />
          Messages
        </h1>
        <p className="text-sm text-muted-foreground">SMS conversations with your contacts</p>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Left Panel: Contact List */}
        <div className="w-80 lg:w-96 border-r border-border flex flex-col shrink-0">
          {/* Search + Filter */}
          <div className="p-3 space-y-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search contacts..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            <div className="flex gap-1">
              {(["all", "unread", "sent"] as FilterType[]).map((f) => (
                <Button
                  key={f}
                  variant={filter === f ? "default" : "ghost"}
                  size="sm"
                  className="h-7 text-xs flex-1"
                  onClick={() => setFilter(f)}
                >
                  {f === "all" ? "All" : f === "unread" ? "Unread" : "Sent Only"}
                </Button>
              ))}
            </div>
          </div>

          {/* Contact List */}
          <ScrollArea className="flex-1">
            {contactsLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {contacts.length === 0
                  ? "No conversations yet. Messages will appear when you send SMS to contacts."
                  : "No conversations match your filter."}
              </div>
            ) : (
              <div>
                {filteredContacts.map((c) => (
                  <button
                    key={c.id}
                    className={`w-full text-left p-3 flex items-start gap-3 hover:bg-secondary/50 transition-colors border-b border-border/50 ${
                      selectedContactId === c.id ? "bg-secondary" : ""
                    }`}
                    onClick={() => setSelectedContactId(c.id)}
                  >
                    <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <span className="text-xs font-display font-bold text-primary">
                        {c.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className={`text-sm truncate ${c.hasUnread ? "font-bold" : "font-medium"}`}>
                          {c.full_name}
                        </p>
                        <span className="text-[10px] text-muted-foreground shrink-0 ml-2">
                          {formatDistanceToNow(new Date(c.lastMessageAt), { addSuffix: false })}
                        </span>
                      </div>
                      <p className={`text-xs truncate mt-0.5 ${c.hasUnread ? "text-foreground" : "text-muted-foreground"}`}>
                        {c.lastMessage}
                      </p>
                    </div>
                    {c.hasUnread && (
                      <div className="w-2.5 h-2.5 rounded-full bg-primary shrink-0 mt-1" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Right Panel: Conversation */}
        <div className="flex-1 flex flex-col min-w-0">
          {!selectedContactId ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
              <div className="text-center">
                <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p>Select a contact to view conversation</p>
              </div>
            </div>
          ) : (
            <>
              {/* Contact Banner */}
              {selectedContact && (
                <div className="p-3 border-b border-border bg-secondary/20 flex items-center gap-3 shrink-0">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-display font-semibold text-sm">{selectedContact.full_name}</p>
                      {selectedContact.phone && (
                        <span className="text-xs text-muted-foreground">{selectedContact.phone}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">
                        {selectedContact.pipeline === "Onboarding" ? "Onboarding" : "Sales"}
                      </Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        {stageLabel(selectedContact.stage, selectedContact.pipeline)}
                      </Badge>
                      {activeSeq && (
                        <Badge variant="default" className="text-[10px]">
                          <Zap className="w-3 h-3 mr-0.5" />
                          {(activeSeq as any).sequences?.name || "Sequence"} — Step {activeSeq.current_step}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Link to={`/contacts/${selectedContact.id}`}>
                    <Button variant="ghost" size="sm" className="text-xs">
                      Profile <ArrowRight className="w-3 h-3 ml-1" />
                    </Button>
                  </Link>
                </div>
              )}

              {/* Messages */}
              <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
                {msgsLoading ? (
                  <div className="flex justify-center py-12">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                    No messages yet.
                  </div>
                ) : (
                  <>
                    {messages.map((msg) => (
                      <MessageBubble key={msg.id} message={msg} />
                    ))}
                  </>
                )}
              </div>

              {/* Compose */}
              <ComposeBar
                contactId={selectedContactId}
                contactName={selectedContact?.full_name || ""}
                contactPhone={selectedContact?.phone || null}
                onSent={() => {
                  qc.invalidateQueries({ queryKey: ["conversation", selectedContactId] });
                  qc.invalidateQueries({ queryKey: ["conversation_contacts"] });
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
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
        className={`max-w-[70%] rounded-2xl px-4 py-2.5 ${
          isOutbound
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-secondary text-secondary-foreground rounded-bl-md"
        } ${isCancelled ? "opacity-50 line-through" : ""}`}
      >
        <p className="text-sm whitespace-pre-wrap">{message.message_content}</p>
        <div className={`flex items-center gap-1.5 mt-1 ${
          isOutbound ? "text-primary-foreground/60" : "text-muted-foreground"
        }`}>
          <span className="text-[10px]">
            {format(new Date(message.sent_at || message.scheduled_at), "MMM d, h:mm a")}
          </span>
          {isPending && (
            <Badge variant="outline" className="text-[8px] h-4 border-primary-foreground/30 text-primary-foreground/60">
              Pending
            </Badge>
          )}
          {message.status === "sent" && (
            <span className="text-[10px]">✓</span>
          )}
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
}: {
  contactId: string;
  contactName: string;
  contactPhone: string | null;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!text.trim()) return;
    setSending(true);
    try {
      // Fetch business_id for the contact
      const { data: contactData } = await supabase
        .from("contacts")
        .select("business_id")
        .eq("id", contactId)
        .single();

      const { error } = await supabase.from("message_queue").insert({
        contact_id: contactId,
        message_content: text.trim(),
        message_type: "sms",
        scheduled_at: new Date().toISOString(),
        status: "pending",
        to_phone: contactPhone,
        business_id: contactData?.business_id ?? null,
        metadata: { to: contactPhone },
      });
      if (error) throw error;

      await navigator.clipboard.writeText(text.trim());
      await logActivity("message_queued", `Manual SMS queued: "${text.trim().slice(0, 60)}…"`, contactId);
      toast.success("Message queued & copied to clipboard", {
        description: contactPhone ? `Send to ${contactPhone}` : "No phone number on file",
      });
      setText("");
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
    <div className="p-3 border-t border-border bg-card shrink-0">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${contactName}...`}
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring min-h-[40px] max-h-[120px]"
            rows={1}
          />
        </div>
        <Button
          onClick={handleSend}
          disabled={!text.trim() || sending}
          className="shrink-0"
          size="icon"
        >
          {sending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </Button>
      </div>
      <p className="text-[10px] text-muted-foreground mt-1 flex items-center gap-1">
        <Copy className="w-3 h-3" /> Messages are copied to clipboard for manual sending
      </p>
    </div>
  );
}
