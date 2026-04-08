import { supabase } from "@/lib/supabase";

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string;

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    console.log("[SW] registered:", reg.scope);
    return reg;
  } catch (err) {
    console.error("[SW] registration failed:", err);
    return null;
  }
}

export async function requestNotificationPermission(businessId: string): Promise<boolean> {
  if (!("Notification" in window) || !("PushManager" in window)) {
    console.warn("[Push] not supported in this browser");
    return false;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    console.log("[Push] permission denied:", permission);
    return false;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    const { error } = await supabase.from("push_subscriptions").upsert(
      { business_id: businessId, subscription: subscription.toJSON() },
      { onConflict: "business_id" }
    );

    if (error) {
      console.error("[Push] failed to save subscription:", error.message);
      return false;
    }

    console.log("[Push] subscription saved for business:", businessId);
    return true;
  } catch (err) {
    console.error("[Push] subscribe error:", err);
    return false;
  }
}

export async function getNotificationPermissionState(): Promise<NotificationPermission | "unsupported"> {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}
