import { create } from 'zustand';
import type { Message, PendingImage } from '../types';

interface ScrollPosition {
  isAtBottom: boolean;
}

interface SessionState {
  // Messages by session
  messages: Map<string, Message[]>;

  // Input state by session
  inputText: Map<string, string>;
  pendingImages: Map<string, PendingImage[]>;

  // Scroll state by session
  scrollPosition: Map<string, ScrollPosition>;

  // Message deduplication
  seenMessageKeys: Map<string, Set<string>>;

  // Actions
  setMessages: (sessionId: string, messages: Message[]) => void;
  addMessage: (sessionId: string, message: Message) => boolean; // returns false if duplicate
  clearMessages: (sessionId: string) => void;

  setInputText: (sessionId: string, text: string) => void;
  addPendingImage: (sessionId: string, image: PendingImage) => void;
  removePendingImage: (sessionId: string, index: number) => void;
  clearPendingImages: (sessionId: string) => void;

  setScrollPosition: (sessionId: string, isAtBottom: boolean) => void;
  getScrollPosition: (sessionId: string) => ScrollPosition;
}

// Generate a key for deduplication
function getMessageKey(message: Message): string | null {
  if (message.type === 'user') {
    const content = message.result ||
      (typeof message.message?.content === 'string'
        ? message.message.content
        : JSON.stringify(message.message?.content));
    return `user:${content?.slice(0, 100)}`;
  }
  if (message.type === 'assistant' && message.message?.id) {
    return `assistant:${message.message.id}`;
  }
  if (message.type === 'system' && message.subtype === 'init') {
    return `init:${message.session_id}`;
  }
  if (message.type === 'result') {
    return `result:${message.result?.slice(0, 50)}:${message.is_error}`;
  }
  return null; // Don't dedupe messages without a key
}

export const useSessionStore = create<SessionState>((set, get) => ({
  messages: new Map(),
  inputText: new Map(),
  pendingImages: new Map(),
  scrollPosition: new Map(),
  seenMessageKeys: new Map(),

  setMessages: (sessionId, messages) => {
    const messagesMap = new Map(get().messages);
    const existingMessages = messagesMap.get(sessionId) || [];
    const existingSeenKeys = get().seenMessageKeys.get(sessionId) || new Set();

    // Build seen keys from incoming messages
    const incomingKeys = new Set<string>();
    for (const msg of messages) {
      const key = getMessageKey(msg);
      if (key) incomingKeys.add(key);
    }

    // Find locally-added messages not in the incoming history
    // These are messages we added locally that the server hasn't echoed back yet
    const pendingLocalMessages: Message[] = [];
    for (const msg of existingMessages) {
      const key = getMessageKey(msg);
      if (key && existingSeenKeys.has(key) && !incomingKeys.has(key)) {
        // This message was added locally but isn't in server history yet
        pendingLocalMessages.push(msg);
      }
    }

    // Merge: server history + pending local messages
    const mergedMessages = [...messages, ...pendingLocalMessages];

    // Update seen keys to include both
    const seenKeys = new Set<string>();
    for (const msg of mergedMessages) {
      const key = getMessageKey(msg);
      if (key) seenKeys.add(key);
    }

    messagesMap.set(sessionId, mergedMessages);
    const seenMap = new Map(get().seenMessageKeys);
    seenMap.set(sessionId, seenKeys);

    set({ messages: messagesMap, seenMessageKeys: seenMap });
  },

  addMessage: (sessionId, message) => {
    const key = getMessageKey(message);

    // Check for duplicate
    if (key) {
      const seenMap = new Map(get().seenMessageKeys);
      const seen = seenMap.get(sessionId) || new Set();
      if (seen.has(key)) {
        return false; // Duplicate
      }
      seen.add(key);
      seenMap.set(sessionId, seen);
      set({ seenMessageKeys: seenMap });
    }

    const messagesMap = new Map(get().messages);
    const sessionMessages = messagesMap.get(sessionId) || [];
    messagesMap.set(sessionId, [...sessionMessages, message]);
    set({ messages: messagesMap });
    return true;
  },

  clearMessages: (sessionId) => {
    const messagesMap = new Map(get().messages);
    messagesMap.delete(sessionId);
    const seenMap = new Map(get().seenMessageKeys);
    seenMap.delete(sessionId);
    set({ messages: messagesMap, seenMessageKeys: seenMap });
  },

  setInputText: (sessionId, text) => {
    const inputMap = new Map(get().inputText);
    inputMap.set(sessionId, text);
    set({ inputText: inputMap });
  },

  addPendingImage: (sessionId, image) => {
    const imagesMap = new Map(get().pendingImages);
    const images = imagesMap.get(sessionId) || [];
    imagesMap.set(sessionId, [...images, image]);
    set({ pendingImages: imagesMap });
  },

  removePendingImage: (sessionId, index) => {
    const imagesMap = new Map(get().pendingImages);
    const images = imagesMap.get(sessionId) || [];
    imagesMap.set(sessionId, images.filter((_, i) => i !== index));
    set({ pendingImages: imagesMap });
  },

  clearPendingImages: (sessionId) => {
    const imagesMap = new Map(get().pendingImages);
    imagesMap.delete(sessionId);
    set({ pendingImages: imagesMap });
  },

  setScrollPosition: (sessionId, isAtBottom) => {
    const scrollMap = new Map(get().scrollPosition);
    scrollMap.set(sessionId, { isAtBottom });
    set({ scrollPosition: scrollMap });
  },

  getScrollPosition: (sessionId) => {
    return get().scrollPosition.get(sessionId) || { isAtBottom: true };
  },
}));
