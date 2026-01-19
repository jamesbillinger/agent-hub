# Agent Hub Mobile App (Expo/React Native)

## Overview

A native Expo/React Native mobile app that connects to an existing Agent Hub desktop server running on a local network. The app focuses exclusively on `claude-json` chat sessions, providing an IM-style interface for real-time communication with Claude via WebSocket.

## Project Structure

```
agent-hub-mobile/
├── app/                           # Expo Router app directory
│   ├── _layout.tsx                # Root layout with navigation providers
│   ├── index.tsx                  # Entry - redirects to sessions or auth
│   ├── auth/
│   │   ├── _layout.tsx            # Auth stack layout
│   │   ├── connect.tsx            # Server discovery/connection screen
│   │   ├── pairing.tsx            # Pairing code entry screen
│   │   └── pin.tsx                # PIN authentication screen
│   └── (main)/
│       ├── _layout.tsx            # Main tab/stack layout
│       ├── sessions.tsx           # Session list screen
│       ├── session/[id].tsx       # Full-screen chat view
│       └── settings.tsx           # App settings
├── components/
│   ├── chat/
│   │   ├── ChatView.tsx           # Main chat container
│   │   ├── MessageList.tsx        # Scrollable message list
│   │   ├── MessageBubble.tsx      # Individual message component
│   │   ├── UserMessage.tsx        # User message styling
│   │   ├── AssistantMessage.tsx   # Assistant message with markdown
│   │   ├── ToolUseMessage.tsx     # Tool use display
│   │   ├── SystemMessage.tsx      # System/init messages
│   │   ├── ChatInput.tsx          # Message input with send button
│   │   └── ThinkingIndicator.tsx  # "Claude is thinking" animation
│   ├── sessions/
│   │   ├── SessionList.tsx        # Session list with search/filter
│   │   ├── SessionCard.tsx        # Individual session item
│   │   ├── SessionBadge.tsx       # Agent type badge
│   │   └── NewSessionButton.tsx   # FAB for creating sessions
│   ├── auth/
│   │   ├── ServerInput.tsx        # Server URL/IP input
│   │   ├── PairingCodeInput.tsx   # 6-digit code input
│   │   └── PinInput.tsx           # PIN input for quick auth
│   └── common/
│       ├── StatusBar.tsx          # Connection status indicator
│       ├── LoadingScreen.tsx      # Full-screen loading
│       ├── ErrorView.tsx          # Error display
│       └── EmptyState.tsx         # Empty list placeholder
├── hooks/
│   ├── useWebSocket.ts            # WebSocket connection management
│   ├── useAuth.ts                 # Authentication state/actions
│   ├── useSessions.ts             # Sessions API + state
│   ├── useChat.ts                 # Chat message state per session
│   ├── useServerDiscovery.ts      # mDNS/manual server discovery
│   └── useConnectionStatus.ts     # Network/connection monitoring
├── services/
│   ├── api.ts                     # REST API client
│   ├── websocket.ts               # WebSocket connection manager
│   ├── storage.ts                 # Async storage wrapper
│   └── notifications.ts           # Push notification handling
├── stores/
│   ├── authStore.ts               # Zustand auth store
│   ├── sessionsStore.ts           # Sessions state
│   ├── chatStore.ts               # Chat messages per session
│   └── settingsStore.ts           # App settings
├── types/
│   ├── api.ts                     # API response types
│   ├── session.ts                 # Session data types
│   ├── chat.ts                    # Chat message types
│   └── auth.ts                    # Auth-related types
├── utils/
│   ├── formatters.ts              # Token formatting, dates, etc.
│   ├── markdown.ts                # Markdown rendering config
│   └── constants.ts               # App constants
├── app.json                       # Expo configuration
├── package.json
├── tsconfig.json
└── babel.config.js
```

## Key Dependencies

```json
{
  "dependencies": {
    "expo": "~52.0.0",
    "expo-router": "~4.0.0",
    "expo-secure-store": "~14.0.0",
    "expo-notifications": "~0.29.0",
    "expo-haptics": "~14.0.0",
    "expo-network": "~7.0.0",

    "react": "18.3.1",
    "react-native": "0.76.0",
    "react-native-safe-area-context": "^4.12.0",
    "react-native-screens": "~4.1.0",
    "react-native-gesture-handler": "~2.20.0",
    "react-native-reanimated": "~3.16.0",

    "@react-navigation/native": "^7.0.0",
    "@react-navigation/native-stack": "^7.0.0",
    "react-native-markdown-display": "^7.0.2",
    "@shopify/flash-list": "^1.7.0",

    "zustand": "^5.0.0",
    "immer": "^10.1.0",

    "@react-native-async-storage/async-storage": "^2.1.0",
    "@expo/vector-icons": "^14.0.0"
  }
}
```

## Desktop Server API

The mobile app connects to these Agent Hub desktop endpoints:

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/auth/check` | GET | No | Check if token is valid |
| `/api/auth/request-pairing` | POST | No | Request pairing code |
| `/api/auth/pair` | POST | No | Complete pairing with code |
| `/api/auth/pin-status` | GET | No | Check if PIN is configured |
| `/api/auth/pin-login` | POST | No | Authenticate with PIN |
| `/api/sessions` | GET/POST | Yes | List or create sessions |
| `/api/sessions/:id/start` | POST | Yes | Start a session |
| `/api/ws/:id` | WebSocket | - | Real-time chat messages |

## Authentication Flow

```
App Launch
    │
    ▼
Check stored credentials (serverUrl + authToken)
    │
    ├─── No credentials ──► Server Input (IP:port) ──► Check PIN status
    │                                                        │
    │                                   ┌────────────────────┴────────────────────┐
    │                                   │                                         │
    │                                   ▼                                         ▼
    │                           PIN available                            Pairing only
    │                                   │                                         │
    │                                   ▼                                         ▼
    │                           PIN Entry Screen                    Request Pairing
    │                                   │                          (show desktop code)
    │                                   │                                         │
    │                                   │                                         ▼
    │                                   │                          Enter 6-digit code
    │                                   │                                         │
    └─── Has credentials ──► Validate token                                       │
                                   │                                              │
                   ┌───────────────┴───────────────┐                              │
                   │                               │                              │
                   ▼                               ▼                              │
               Valid ──────────────────────► Sessions Screen ◄────────────────────┘
                   │
               Invalid ──► Re-auth flow
```

## State Management (Zustand)

### Auth Store
```typescript
interface AuthState {
  serverUrl: string | null;
  authToken: string | null;
  deviceId: string | null;
  isAuthenticated: boolean;
  pairingId: string | null;
  isPairing: boolean;

  setServerUrl: (url: string) => void;
  requestPairing: (deviceName: string) => Promise<string>;
  completePairing: (code: string) => Promise<void>;
  loginWithPin: (pin: string) => Promise<void>;
  checkAuth: () => Promise<boolean>;
  logout: () => void;
}
```

### Sessions Store
```typescript
interface SessionsState {
  sessions: Session[];
  activeSessionId: string | null;
  isLoading: boolean;

  fetchSessions: () => Promise<void>;
  createSession: (opts: CreateSessionOpts) => Promise<Session>;
  startSession: (id: string) => Promise<void>;
  setActiveSession: (id: string | null) => void;
}
```

### Chat Store
```typescript
interface ChatState {
  messagesBySession: Record<string, ChatMessage[]>;
  processingSessionIds: Set<string>;

  addMessage: (sessionId: string, message: ChatMessage) => void;
  setProcessing: (sessionId: string, isProcessing: boolean) => void;
  clearMessages: (sessionId: string) => void;
}
```

## WebSocket Handling

```typescript
class WebSocketManager {
  private connections: Map<string, WebSocket> = new Map();

  connect(sessionId: string, handlers: WebSocketHandlers): void {
    const wsUrl = `ws://${serverHost}/api/ws/${sessionId}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => handlers.onConnected();
    ws.onmessage = (event) => handlers.onMessage(event.data);
    ws.onclose = () => this.handleClose(sessionId, handlers);

    this.connections.set(sessionId, ws);
  }

  send(sessionId: string, message: string): void {
    const ws = this.connections.get(sessionId);
    if (ws?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: message }
      }) + '\n';
      ws.send(payload);
    }
  }

  disconnect(sessionId: string): void {
    this.connections.get(sessionId)?.close();
    this.connections.delete(sessionId);
  }
}
```

## Message Types

The app handles these JSON message types from Claude:

```typescript
interface ChatMessage {
  type: 'system' | 'user' | 'assistant' | 'result';
  subtype?: 'init' | 'success' | 'error';
  session_id?: string;
  message?: {
    id: string;
    role: string;
    content: ContentBlock[];
    stop_reason?: string | null;
    usage?: TokenUsage;
  };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
  model?: string;
  cwd?: string;
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  name?: string;
  input?: unknown;
}
```

## UI Design

- Match desktop dark theme colors:
  - Background: `#1a1a1a`
  - Secondary: `#252526`
  - Text: `#e6e6e6`
  - Accent: `#0e639c`

- Message bubbles:
  - User: right-aligned, accent blue background
  - Assistant: left-aligned, secondary background
  - Tool use: left border accent, tertiary background
  - System: centered, transparent

## Implementation Phases

1. **Phase 1: Project Setup & Auth**
   - Initialize Expo project
   - Set up navigation
   - Implement auth flow

2. **Phase 2: Sessions List**
   - Sessions store
   - Session list UI
   - Create/delete sessions

3. **Phase 3: WebSocket & Chat**
   - WebSocket manager
   - Chat store
   - Basic message rendering

4. **Phase 4: Message Rendering**
   - Markdown support
   - Tool use display
   - Thinking indicator

5. **Phase 5: Polish**
   - Connection status
   - Error handling
   - Settings screen

## References

- Desktop app source: `src/main.ts` (TypeScript interfaces, chat logic)
- API endpoints: `src-tauri/src/lib.rs` (lines 2750-3600)
- Styling: `src/styles.css` (chat message styles)
