import { useState, useEffect, useRef, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { invokeFunction } from "@/lib/invokeFunction";
import { ADMIN_BUSINESS_ID } from "@/lib/constants";
import { useCustomValues, replaceCustomValues } from "@/hooks/useCustomValues";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowUp, Loader2, Phone, Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";
import { getInitials, getAvatarTone } from "@/lib/initials";

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

function renderContent(text: string) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.split(urlRegex).map((part, i) =>
    urlRegex.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 text-primary">
        View link
      </a>
    ) : part
  );
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
      const { data: contact } = await supabase.from("contacts").select("full_name").eq("id", contactId!).single();
      const name = contact?.full_name || "Unknown";
      return (data || []).map((msg) => ({
        id: msg.id,
        message_content: replaceCustomValues(msg.message_content.replace(/\{\{contact_name\}\}/g, name), customValues),
        message_type: msg.message_type,
        status: msg.status,
        scheduled_at: msg.scheduled_at,
        sent_at: msg.sent_at,
        created_at: msg.created_at,
        direction: (msg.direction ?? "outbound") as "outbound" | "inbound",
      })).sort((a, b) => new Date(a.sent_at ?? a.scheduled_at).getTime() - new Date(b.sent_at ?? b.scheduled_at).getTime()) as Message[];
    },
    refetchInterval: 10000,
  });
}

function Bubble({ message }: { message: Message }) {
  const isOut = message.direction === "outbound";
  const isCall = message.message_type === "call";
  if (isCall) {
    return (
      <div className="flex justify-center">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-secondary/60 rounded-full px-3 py-1.5 select-none"
          title={format(new Date(message.sent_at || message.scheduled_at), "MMM d · h:mm a")}>
          <Phone className="w-3 h-3" strokeWidth={1.5} />
          {message.message_content}
        </div>
      </div>
    );
  }
  return (
    <div className={`flex ${isOut ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 ${isOut ? "bg-foreground/80 text-background" : "bg-[var(--bubble-in-bg)] text-[var(--bubble-in-text)]"} ${message.status === "cancelled" ? "opacity-50 line-through" : ""} ${message.status === "pending" && isOut ? "opacity-60" : ""}`}
        title={format(new Date(message.sent_at || message.scheduled_at), "MMM d · h:mm a")}
      >
        <p className="text-[15px] leading-[1.45] whitespace-pre-wrap">{renderContent(message.message_content)}</p>
        {message.status === "pending" && (
          <div className="flex items-center mt-1">
            <Badge variant="outline" className="text-[10px] h-4 border-border/60 text-muted-foreground font-normal">Pending</Badge>
          </div>
        )}
      </div>
    </div>
  );
}

function Compose({ contactId, contactName, contactPhone, onSent, onOptimistic, onRollback }: {
  contactId: string; contactName: string; contactPhone: string | null;
  onSent: () => void; onOptimistic: (msg: Message) => void; onRollback: (t: string) => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${ref.current.scrollHeight}px`;
    }
  }, [text]);

  const handleSend = async () => {
    if (!text.trim()) return;
    setSending(true);
    const content = text.trim();
    const scheduledAt = new Date().toISOString();
    onOptimistic({ id: `opt-${scheduledAt}`, message_content: content, message_type: "sms", status: "pending", scheduled_at: scheduledAt, sent_at: null, created_at: scheduledAt, direction: "outbound" });
    setText("");
    try {
      const { data: cd } = await supabase.from("contacts").select("business_id").eq("id", contactId).single();
      const businessId = cd?.business_id ?? ADMIN_BUSINESS_ID;
      const { data, error } = await invokeFunction<{ error?: string }>("send-manual-sms", { contact_id: contactId, business_id: businessId, message: content, to_phone: contactPhone });
      if (error || data?.error) { onRollback(scheduledAt); setText(content); throw new Error(data?.error ?? "Send failed"); }
      onSent();
    } catch { toast.error("Failed to send message"); } finally { setSending(false); }
  };

  const handleSuggest = async () => {
    setSuggesting(true);
    try {
      const { data, error } = await invokeFunction<{ suggestion: string; error?: string }>("suggest-reply", { contact_id: contactId, contact_name: contactName });
      if (error || data?.error) throw new Error(data?.error ?? "Failed");
      if (data?.suggestion) setText(data.suggestion);
    } catch { toast.error("Couldn't generate suggestion"); } finally { setSuggesting(false); }
  };

  return (
    <div className="px-3 pb-3 pt-2 shrink-0">
      <div className="relative rounded-2xl border border-border/60 bg-background focus-within:border-border focus-within:ring-2 focus-within:ring-ring transition-all shadow-md">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = `${e.target.scrollHeight}px`; }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="Message…"
          inputMode="text" autoComplete="new-password" autoCorrect="off" autoCapitalize="off" spellCheck={false} data-form-type="other"
          className="block w-full resize-none bg-transparent pl-4 pr-4 pt-3 pb-10 text-base placeholder:text-muted-foreground focus:outline-none min-h-[52px] max-h-[160px] overflow-y-auto"
          rows={1}
        />
        <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-2 pb-2">
          <button type="button" onClick={handleSuggest} disabled={suggesting || sending}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 px-1.5 py-1 rounded-lg hover:bg-secondary/60">
            {suggesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            <span>{suggesting ? "Thinking…" : "Suggest"}</span>
          </button>
          <button type="button" onClick={handleSend} disabled={sending || !text.trim()} aria-label="Send"
            className={`h-9 w-9 rounded-xl flex items-center justify-center bg-primary text-primary-foreground hover:brightness-110 transition-all duration-200 origin-center ${text.trim() || sending ? "scale-100 opacity-100" : "scale-50 opacity-0 pointer-events-none"}`}>
            {sending ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={2} /> : <ArrowUp className="w-4 h-4" strokeWidth={2.5} />}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ConversationDrawer({ contactId, contactName, contactPhone, open, onOpenChange }: {
  contactId: string | null;
  contactName: string;
  contactPhone: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const { data: messages = [], isLoading } = useConversation(open ? contactId : null);
  const [optimistic, setOptimistic] = useState<Message[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const heroName = contactName.trim();
  const heroIsPhone = !heroName || /^[+\d]/.test(heroName);

  useEffect(() => { setOptimistic([]); }, [contactId]);

  useEffect(() => {
    if (optimistic.length === 0 || messages.length === 0) return;
    setOptimistic((prev) => prev.filter((opt) =>
      !messages.some((real) => real.direction === "outbound" && real.message_content === opt.message_content &&
        Math.abs(new Date(real.scheduled_at).getTime() - new Date(opt.scheduled_at).getTime()) < 5000)
    ));
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  const allMessages = useMemo(() => {
    const deduped = optimistic.filter((opt) =>
      !messages.some((real) => real.direction === "outbound" && real.message_content === opt.message_content &&
        Math.abs(new Date(real.scheduled_at).getTime() - new Date(opt.scheduled_at).getTime()) < 5000)
    );
    return [...messages, ...deduped].sort((a, b) =>
      new Date(a.sent_at ?? a.scheduled_at).getTime() - new Date(b.sent_at ?? b.scheduled_at).getTime()
    );
  }, [messages, optimistic]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [allMessages]);

  if (!contactId) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col gap-0">
        {/* Header */}
        <Link
          to="/messages"
          state={{ contactId }}
          onClick={() => onOpenChange(false)}
          className="pl-4 pr-12 py-3 border-b border-border/40 bg-background/90 backdrop-blur-sm flex items-center gap-3 shrink-0 hover:bg-secondary/20 transition-colors"
        >
          <div className={`w-9 h-9 rounded-full ${heroIsPhone ? "bg-secondary" : getAvatarTone(heroName)} flex items-center justify-center shrink-0`}>
            {heroIsPhone ? <Phone className="w-4 h-4 text-muted-foreground" strokeWidth={1.5} /> :
              <span className="text-xs font-medium text-white/95">{getInitials(heroName)}</span>}
          </div>
          <p className="font-semibold text-[15px] flex-1 truncate">{contactName}</p>
        </Link>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto overscroll-contain px-3 py-4 space-y-1.5">
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : allMessages.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-12">No messages yet.</p>
          ) : (
            (() => {
              const elements: React.ReactNode[] = [];
              let lastTime: number | null = null;
              for (const msg of allMessages) {
                const t = new Date(msg.sent_at || msg.scheduled_at).getTime();
                if (lastTime === null || t - lastTime > 5 * 60 * 1000) {
                  elements.push(
                    <div key={`sep-${msg.id}`} className="flex items-center gap-3 py-2 select-none">
                      <div className="flex-1 h-px bg-border/40" />
                      <span className="text-[11px] text-muted-foreground/70 shrink-0">{format(new Date(t), "MMM d · h:mm a")}</span>
                      <div className="flex-1 h-px bg-border/40" />
                    </div>
                  );
                }
                elements.push(<Bubble key={msg.id} message={msg} />);
                lastTime = t;
              }
              return elements;
            })()
          )}
        </div>

        {/* Compose */}
        <Compose
          contactId={contactId}
          contactName={contactName}
          contactPhone={contactPhone}
          onSent={() => {
            qc.invalidateQueries({ queryKey: ["conversation", contactId] });
            qc.invalidateQueries({ queryKey: ["conversation_contacts"] });
          }}
          onOptimistic={(msg) => setOptimistic((prev) => [...prev, msg])}
          onRollback={(t) => setOptimistic((prev) => prev.filter((m) => m.scheduled_at !== t))}
        />
      </SheetContent>
    </Sheet>
  );
}
