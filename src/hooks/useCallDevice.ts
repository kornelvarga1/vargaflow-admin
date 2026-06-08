import { useState, useEffect, useRef, useCallback } from "react";
import { Device, Call } from "@twilio/voice-sdk";
import { invokeFunction } from "@/lib/invokeFunction";

export type CallState = "idle" | "connecting" | "active" | "incoming";

export function useCallDevice(businessId?: string) {
  const deviceRef = useRef<Device | null>(null);
  const [callState, setCallState] = useState<CallState>("idle");
  const [activeCall, setActiveCall] = useState<Call | null>(null);
  const [incomingCall, setIncomingCall] = useState<Call | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let device: Device;

    const init = async () => {
      const { data, error } = await invokeFunction<{ token: string }>("twilio-token", businessId ? { business_id: businessId } : undefined);
      if (error || !data?.token) {
        console.error("[callDevice] token fetch failed:", error);
        return;
      }

      device = new Device(data.token, { logLevel: "error" });

      device.on("registered", () => setReady(true));
      device.on("unregistered", () => setReady(false));
      device.on("error", (err) => console.error("[callDevice] error:", err));

      device.on("incoming", (call: Call) => {
        setIncomingCall(call);
        setCallState("incoming");
        call.on("disconnect", () => { setIncomingCall(null); setCallState("idle"); });
        call.on("cancel", () => { setIncomingCall(null); setCallState("idle"); });
      });

      await device.register();
      deviceRef.current = device;
    };

    init();

    return () => {
      device?.unregister();
      device?.destroy();
    };
  }, [businessId]);

  const call = useCallback(async (toPhone: string, contactId: string) => {
    const device = deviceRef.current;
    if (!device || !ready) return;

    setCallState("connecting");
    try {
      const c = await device.connect({ params: { To: toPhone, ContactId: contactId, ...(businessId ? { BusinessId: businessId } : {}) } });
      setActiveCall(c);
      setCallState("active");
      c.on("disconnect", () => { setActiveCall(null); setCallState("idle"); });
      c.on("error", () => { setActiveCall(null); setCallState("idle"); });
    } catch (err) {
      console.error("[callDevice] connect failed:", err);
      setCallState("idle");
    }
  }, [ready]);

  const hangup = useCallback(() => {
    activeCall?.disconnect();
    incomingCall?.reject();
    setActiveCall(null);
    setIncomingCall(null);
    setCallState("idle");
  }, [activeCall, incomingCall]);

  const answer = useCallback(() => {
    if (!incomingCall) return;
    incomingCall.accept();
    setActiveCall(incomingCall);
    setIncomingCall(null);
    setCallState("active");
    incomingCall.on("disconnect", () => { setActiveCall(null); setCallState("idle"); });
  }, [incomingCall]);

  return { ready, callState, activeCall, incomingCall, call, hangup, answer };
}
