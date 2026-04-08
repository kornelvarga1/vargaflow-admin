import { createContext, useContext, useState, ReactNode } from "react";

type Ctx = { isConversationOpen: boolean; setConversationOpen: (v: boolean) => void };

const ConversationContext = createContext<Ctx>({ isConversationOpen: false, setConversationOpen: () => {} });

export function ConversationProvider({ children }: { children: ReactNode }) {
  const [isConversationOpen, setConversationOpen] = useState(false);
  return (
    <ConversationContext.Provider value={{ isConversationOpen, setConversationOpen }}>
      {children}
    </ConversationContext.Provider>
  );
}

export function useConversationOpen() {
  return useContext(ConversationContext);
}
