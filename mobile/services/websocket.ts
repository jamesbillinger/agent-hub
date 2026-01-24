import { ChatMessage } from '../types/chat';

export interface WebSocketHandlers {
  onConnected: () => void;
  onDisconnected: () => void;
  onMessage: (message: ChatMessage) => void;
  onError: (error: Error) => void;
}

class WebSocketManager {
  private connections: Map<string, WebSocket> = new Map();
  private handlers: Map<string, WebSocketHandlers> = new Map();
  private reconnectAttempts: Map<string, number> = new Map();
  private reconnectTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;

  connect(sessionId: string, url: string, handlers: WebSocketHandlers): void {
    // Close existing connection if any
    this.disconnect(sessionId);

    this.handlers.set(sessionId, handlers);
    this.createConnection(sessionId, url);
  }

  private createConnection(sessionId: string, url: string): void {
    const handlers = this.handlers.get(sessionId);
    if (!handlers) return;

    try {
      const ws = new WebSocket(url);

      ws.onopen = () => {
        this.reconnectAttempts.set(sessionId, 0);
        handlers.onConnected();
      };

      ws.onmessage = (event) => {
        try {
          // Handle potential newline-delimited JSON
          let data = event.data.toString().trim();
          if (!data) return;

          // Strip terminal escape sequences (iTerm2 shell integration, etc.)
          // These appear as \x1b]....\x07 before the JSON
          const jsonStart = data.indexOf('{');
          if (jsonStart > 0) {
            data = data.substring(jsonStart);
          }

          // Also handle array JSON
          if (jsonStart === -1) {
            const arrayStart = data.indexOf('[');
            if (arrayStart > 0) {
              data = data.substring(arrayStart);
            }
          }

          if (!data.startsWith('{') && !data.startsWith('[')) {
            return;
          }

          const message = JSON.parse(data) as ChatMessage;
          handlers.onMessage(message);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error, event.data);
        }
      };

      ws.onerror = (error) => {
        console.error(`WebSocket error for session ${sessionId}:`, error);
        handlers.onError(new Error('WebSocket connection error'));
      };

      ws.onclose = (event) => {
        this.connections.delete(sessionId);
        handlers.onDisconnected();

        // Attempt reconnection if not intentionally closed
        if (event.code !== 1000) {
          this.scheduleReconnect(sessionId, url);
        }
      };

      this.connections.set(sessionId, ws);
    } catch (error) {
      console.error(`Failed to create WebSocket for session ${sessionId}:`, error);
      handlers.onError(error instanceof Error ? error : new Error('Connection failed'));
    }
  }

  private scheduleReconnect(sessionId: string, url: string): void {
    const attempts = this.reconnectAttempts.get(sessionId) || 0;

    if (attempts >= this.maxReconnectAttempts) {
      const handlers = this.handlers.get(sessionId);
      handlers?.onError(new Error('Failed to reconnect after multiple attempts'));
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, attempts);

    const timeout = setTimeout(() => {
      this.reconnectAttempts.set(sessionId, attempts + 1);
      this.createConnection(sessionId, url);
    }, delay);

    this.reconnectTimeouts.set(sessionId, timeout);
  }

  send(sessionId: string, content: string): boolean {
    const ws = this.connections.get(sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error(`Cannot send message: WebSocket not connected for session ${sessionId}`);
      return false;
    }

    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
    }) + '\n';

    ws.send(payload);
    return true;
  }

  disconnect(sessionId: string): void {
    // Clear reconnect timeout
    const timeout = this.reconnectTimeouts.get(sessionId);
    if (timeout) {
      clearTimeout(timeout);
      this.reconnectTimeouts.delete(sessionId);
    }

    // Close connection
    const ws = this.connections.get(sessionId);
    if (ws) {
      ws.close(1000, 'Client disconnect');
      this.connections.delete(sessionId);
    }

    // Clear handlers
    this.handlers.delete(sessionId);
    this.reconnectAttempts.delete(sessionId);
  }

  disconnectAll(): void {
    for (const sessionId of this.connections.keys()) {
      this.disconnect(sessionId);
    }
  }

  isConnected(sessionId: string): boolean {
    const ws = this.connections.get(sessionId);
    return ws?.readyState === WebSocket.OPEN;
  }

  getConnectionState(sessionId: string): 'connecting' | 'open' | 'closing' | 'closed' | 'none' {
    const ws = this.connections.get(sessionId);
    if (!ws) return 'none';

    switch (ws.readyState) {
      case WebSocket.CONNECTING:
        return 'connecting';
      case WebSocket.OPEN:
        return 'open';
      case WebSocket.CLOSING:
        return 'closing';
      case WebSocket.CLOSED:
        return 'closed';
      default:
        return 'none';
    }
  }
}

export const wsManager = new WebSocketManager();
