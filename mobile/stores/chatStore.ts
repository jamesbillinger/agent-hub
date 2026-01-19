import { create } from 'zustand';
import { ChatMessage, ChatMessageWithId } from '../types/chat';
import { generateId } from '../utils/formatters';

interface ChatState {
  messagesBySession: Record<string, ChatMessageWithId[]>;
  processingSessionIds: Set<string>;
  connectedSessionIds: Set<string>;

  // Actions
  addMessage: (sessionId: string, message: ChatMessage) => void;
  addUserMessage: (sessionId: string, content: string) => void;
  setProcessing: (sessionId: string, isProcessing: boolean) => void;
  setConnected: (sessionId: string, isConnected: boolean) => void;
  clearMessages: (sessionId: string) => void;
  getMessages: (sessionId: string) => ChatMessageWithId[];
  isProcessing: (sessionId: string) => boolean;
  isConnected: (sessionId: string) => boolean;
}

export const useChatStore = create<ChatState>((set, get) => ({
  messagesBySession: {},
  processingSessionIds: new Set(),
  connectedSessionIds: new Set(),

  addMessage: (sessionId: string, message: ChatMessage) => {
    const messageWithId: ChatMessageWithId = {
      ...message,
      localId: generateId(),
      timestamp: Date.now(),
    };

    set(state => {
      const existingMessages = state.messagesBySession[sessionId] || [];

      // Handle result messages - they mark end of processing
      if (message.type === 'result') {
        const newProcessing = new Set(state.processingSessionIds);
        newProcessing.delete(sessionId);
        return {
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: [...existingMessages, messageWithId],
          },
          processingSessionIds: newProcessing,
        };
      }

      // Handle assistant messages - start processing on first one
      if (message.type === 'assistant') {
        const newProcessing = new Set(state.processingSessionIds);
        newProcessing.add(sessionId);
        return {
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: [...existingMessages, messageWithId],
          },
          processingSessionIds: newProcessing,
        };
      }

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: [...existingMessages, messageWithId],
        },
      };
    });
  },

  addUserMessage: (sessionId: string, content: string) => {
    const userMessage: ChatMessageWithId = {
      type: 'user',
      message: { role: 'user', content },
      localId: generateId(),
      timestamp: Date.now(),
    };

    set(state => {
      const existingMessages = state.messagesBySession[sessionId] || [];
      const newProcessing = new Set(state.processingSessionIds);
      newProcessing.add(sessionId);

      return {
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: [...existingMessages, userMessage],
        },
        processingSessionIds: newProcessing,
      };
    });
  },

  setProcessing: (sessionId: string, isProcessing: boolean) => {
    set(state => {
      const newProcessing = new Set(state.processingSessionIds);
      if (isProcessing) {
        newProcessing.add(sessionId);
      } else {
        newProcessing.delete(sessionId);
      }
      return { processingSessionIds: newProcessing };
    });
  },

  setConnected: (sessionId: string, isConnected: boolean) => {
    set(state => {
      const newConnected = new Set(state.connectedSessionIds);
      if (isConnected) {
        newConnected.add(sessionId);
      } else {
        newConnected.delete(sessionId);
      }
      return { connectedSessionIds: newConnected };
    });
  },

  clearMessages: (sessionId: string) => {
    set(state => {
      const { [sessionId]: _, ...rest } = state.messagesBySession;
      const newProcessing = new Set(state.processingSessionIds);
      newProcessing.delete(sessionId);
      return {
        messagesBySession: rest,
        processingSessionIds: newProcessing,
      };
    });
  },

  getMessages: (sessionId: string) => {
    return get().messagesBySession[sessionId] || [];
  },

  isProcessing: (sessionId: string) => {
    return get().processingSessionIds.has(sessionId);
  },

  isConnected: (sessionId: string) => {
    return get().connectedSessionIds.has(sessionId);
  },
}));
