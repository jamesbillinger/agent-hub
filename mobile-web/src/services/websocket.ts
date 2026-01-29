import { useAuthStore } from '../stores/authStore';
import { useGlobalStore } from '../stores/globalStore';
import { useSessionStore } from '../stores/sessionStore';
import type { Message } from '../types/message';
import type { ClientMessage, ServerMessage } from '../types/websocket';

class WebSocketService {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private isAuthenticated = false;
  private pendingMessages: ClientMessage[] = [];

  connect() {
    const token = useAuthStore.getState().authToken;
    if (!token && !this.isFirstTimeSetup()) {
      console.log('No auth token, not connecting WebSocket');
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      console.log('WebSocket already connected');
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/ws/mobile`;

    console.log('Connecting to WebSocket:', wsUrl);
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected');
      this.reconnectAttempts = 0;
      useGlobalStore.getState().setConnected(true);

      // Authenticate
      this.send({ type: 'auth', token: token || '' });

      // Start ping interval
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          // WebSocket ping is handled by the server, but we could send a custom ping if needed
        }
      }, 30000);
    };

    this.ws.onclose = (event) => {
      console.log('WebSocket closed:', event.code, event.reason);
      this.isAuthenticated = false;
      useGlobalStore.getState().setConnected(false);
      this.cleanup();

      // Reconnect if not intentionally closed
      if (event.code !== 1000 && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
        console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this.connect(), delay);
      }
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as ServerMessage;
        this.handleMessage(message);
      } catch (e) {
        console.error('Failed to parse WebSocket message:', e);
      }
    };
  }

  private isFirstTimeSetup(): boolean {
    // Check if there are no paired devices (first-time setup allows unauthenticated access)
    // This would need to be checked via API first, but for now we'll just try to connect
    return false;
  }

  private handleMessage(message: ServerMessage) {
    const globalStore = useGlobalStore.getState();
    const sessionStore = useSessionStore.getState();

    switch (message.type) {
      case 'auth_success':
        console.log('WebSocket authenticated');
        this.isAuthenticated = true;
        // Flush any pending messages that were queued before auth
        this.flushPendingMessages();
        break;

      case 'auth_error':
        console.error('WebSocket auth error:', message.message);
        useAuthStore.getState().logout();
        break;

      case 'session_list':
        // Update the sessions in global store
        globalStore.setSessions(message.sessions);
        break;

      case 'session_status':
        // Update session status (running, isProcessing)
        globalStore.updateSessionStatus(message.sessionId, message.status);
        break;

      case 'session_created':
        globalStore.addSession(message.session);
        break;

      case 'session_updated':
        globalStore.updateSession(message.session);
        break;

      case 'session_deleted':
        globalStore.removeSession(message.sessionId);
        break;

      case 'chat_message':
        // Add message to session's message list
        this.handleChatMessage(message.sessionId, message.message);
        break;

      case 'chat_history':
        // Set the chat history for a session
        sessionStore.setMessages(message.sessionId, message.messages);
        break;

      case 'error':
        console.error('Server error:', message.message);
        break;

      default:
        console.warn('Unknown message type:', message);
    }
  }

  private handleChatMessage(sessionId: string, messageData: Message | string) {
    const sessionStore = useSessionStore.getState();

    // The message might be a raw JSON string from the Claude process
    let message: Message;
    if (typeof messageData === 'string') {
      try {
        message = JSON.parse(messageData) as Message;
      } catch {
        // If it can't be parsed, it's probably raw output - wrap it as system message
        message = {
          type: 'system',
          result: messageData,
        };
      }
    } else {
      message = messageData;
    }

    sessionStore.addMessage(sessionId, message);
  }

  subscribe(sessionId: string) {
    this.send({ type: 'subscribe', sessionId });
  }

  unsubscribe(sessionId: string) {
    this.send({ type: 'unsubscribe', sessionId });
  }

  sendMessage(sessionId: string, content: unknown) {
    // Format message the same way desktop does:
    // {"type":"user","message":{"role":"user","content":"..."}}
    const formattedMessage = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    }) + '\n';
    this.send({ type: 'send_message', sessionId, content: formattedMessage });
  }

  interrupt(sessionId: string) {
    this.send({ type: 'interrupt', sessionId });
  }

  private send(message: ClientMessage) {
    // Auth messages should always go through immediately
    if (message.type === 'auth') {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(message));
      }
      return;
    }

    // Queue other messages if not authenticated yet
    if (!this.isAuthenticated) {
      console.log('Queueing message until authenticated:', message.type);
      this.pendingMessages.push(message);
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('WebSocket not connected, cannot send:', message);
    }
  }

  private flushPendingMessages() {
    if (this.pendingMessages.length > 0) {
      console.log(`Flushing ${this.pendingMessages.length} pending messages`);
      for (const msg of this.pendingMessages) {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify(msg));
        }
      }
      this.pendingMessages = [];
    }
  }

  private cleanup() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  disconnect() {
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, 'Client disconnecting');
      this.ws = null;
    }
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnect
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

// Singleton instance
export const websocketService = new WebSocketService();
