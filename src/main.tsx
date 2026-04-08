import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { registerServiceWorker } from "./hooks/usePushNotifications";

createRoot(document.getElementById("root")!).render(<App />);

// Register service worker on load (non-blocking)
registerServiceWorker();
