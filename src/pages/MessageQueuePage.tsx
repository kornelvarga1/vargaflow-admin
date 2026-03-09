import { useState } from "react";
import { useMessageQueue, useMarkMessageSent } from "@/hooks/useSequences";
import { useCustomValues, replaceCustomValues } from "@/hooks/useCustomValues";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Copy, Check, Clock, Send, MessageSquare, Mail, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

export default function MessageQueuePage() {
  const [tab, setTab] = useState("pending");
  const { data: messages = [], isLoading } = useMessageQueue(tab === "all" ? undefined : tab);
  const { data: customValues = [] } = useCustomValues();
  const markSent = useMarkMessageSent();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const resolveTemplate = (content: string, contactName?: string) => {
    let resolved = replaceCustomValues(content, customValues);
    if (contactName) {
      resolved = resolved.replace(/\{\{contact_name\}\}/g, contactName);
    }
    return resolved;
  };

  const handleCopy = async (id: string, content: string, contactName?: string) => {
    const resolved = resolveTemplate(content, contactName);
    await navigator.clipboard.writeText(resolved);
    setCopiedId(id);
    toast.success("Copied to clipboard!");
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleMarkSent = async (id: string) => {
    try {
      await markSent.mutateAsync(id);
      toast.success("Marked as sent");
    } catch {
      toast.error("Failed to update");
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto space-y-6 animate-fade-in">
      <div>
        <h1 className="text-2xl font-display font-bold">Message Queue</h1>
        <p className="text-sm text-muted-foreground">
          Copy messages and send them manually. Twilio integration coming soon.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="pending">Pending</TabsTrigger>
          <TabsTrigger value="sent">Sent</TabsTrigger>
          <TabsTrigger value="cancelled">Cancelled</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>

        <TabsContent value={tab} className="mt-4">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : messages.length === 0 ? (
            <Card className="bg-card border-border">
              <CardContent className="p-8 text-center text-muted-foreground text-sm">
                {tab === "pending"
                  ? "No pending messages. Messages appear here when contacts are enrolled in sequences."
                  : `No ${tab} messages.`}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {messages.map((msg: any) => {
                const contactName = msg.contacts?.full_name || "Unknown";
                const resolved = resolveTemplate(msg.message_content, contactName);
                const isCopied = copiedId === msg.id;

                return (
                  <Card key={msg.id} className="bg-card border-border">
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center shrink-0 mt-0.5">
                          {msg.message_type === "sms" ? (
                            <MessageSquare className="w-4 h-4 text-accent-foreground" />
                          ) : (
                            <Mail className="w-4 h-4 text-accent-foreground" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="font-display font-semibold text-sm">{contactName}</span>
                            <Badge variant="outline" className="text-[10px] border-accent/40 text-accent-foreground">
                              {msg.message_type.toUpperCase()}
                            </Badge>
                            <Badge
                              variant={
                                msg.status === "pending"
                                  ? "default"
                                  : msg.status === "sent"
                                  ? "secondary"
                                  : "destructive"
                              }
                              className="text-[10px]"
                            >
                              {msg.status}
                            </Badge>
                            {msg.contacts?.phone && msg.message_type === "sms" && (
                              <span className="text-xs text-muted-foreground">{msg.contacts.phone}</span>
                            )}
                          </div>
                          <p className="text-sm whitespace-pre-wrap mt-1">{resolved}</p>
                          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                            <Clock className="w-3 h-3" />
                            <span>Scheduled: {format(new Date(msg.scheduled_at), "MMM d, h:mm a")}</span>
                            {msg.sent_at && (
                              <span>· Sent: {format(new Date(msg.sent_at), "MMM d, h:mm a")}</span>
                            )}
                          </div>
                        </div>
                        {msg.status === "pending" && (
                          <div className="flex gap-1 shrink-0">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleCopy(msg.id, msg.message_content, contactName)}
                            >
                              {isCopied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                              <span className="ml-1">{isCopied ? "Copied" : "Copy"}</span>
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => handleMarkSent(msg.id)}
                            >
                              <Send className="w-3.5 h-3.5 mr-1" />
                              Sent
                            </Button>
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
