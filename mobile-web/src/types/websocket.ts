import type { Session, SessionStatus, Folder } from './session';
import type { Message } from './message';

// Client -> Server messages
export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; sessionId: string }
  | { type: 'unsubscribe'; sessionId: string }
  | { type: 'send_message'; sessionId: string; content: unknown }
  | { type: 'interrupt'; sessionId: string };

// Server -> Client messages
export type ServerMessage =
  | { type: 'auth_success' }
  | { type: 'auth_error'; message: string }
  | { type: 'session_list'; sessions: Session[]; folders?: Folder[] }
  | { type: 'session_status'; sessionId: string; status: SessionStatus }
  | { type: 'session_created'; session: Session }
  | { type: 'session_updated'; session: Session }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'chat_message'; sessionId: string; message: Message }
  | { type: 'chat_history'; sessionId: string; messages: Message[] }
  | { type: 'error'; message: string };
