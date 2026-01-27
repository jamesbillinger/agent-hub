import React, { useEffect, useCallback, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, AppState, AppStateStatus } from 'react-native';
import { MessageList } from './MessageList';
import { ChatInput } from './ChatInput';
import { ConnectionStatusBar } from '../common/StatusBar';
import { LoadingScreen } from '../common/LoadingScreen';
import { ErrorView } from '../common/ErrorView';
import { apiClient } from '../../services/api';
import { wsManager } from '../../services/websocket';
import { COLORS, FONT_SIZES, SPACING } from '../../utils/constants';
import { ChatMessage, ChatMessageWithId } from '../../types/chat';

interface ChatViewProps {
  sessionId: string;
}

const EMPTY_MESSAGES: ChatMessageWithId[] = [];

type SessionState = 'checking' | 'inactive' | 'starting' | 'connected' | 'disconnected' | 'error';

// Generate a unique key for deduplication based on message content
function getMessageKey(message: ChatMessage): string {
  if (message.type === 'user') {
    return `user:${message.message.content}`;
  }
  if (message.type === 'assistant') {
    const id = message.message?.id;
    if (id) return `assistant:${id}`;
    const content = JSON.stringify(message.message?.content || '');
    return `assistant:${content.substring(0, 100)}`;
  }
  if (message.type === 'system') {
    return `system:${message.subtype}:${message.session_id || ''}`;
  }
  if (message.type === 'result') {
    const uuid = (message as any).uuid;
    if (uuid) return `result:${uuid}`;
    return `result:${message.duration_ms}:${message.total_cost_usd}`;
  }
  return `unknown:${Date.now()}`;
}

export function ChatView({ sessionId }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessageWithId[]>(EMPTY_MESSAGES);
  const [isProcessing, setIsProcessingLocal] = useState(false);
  const [sessionState, setSessionState] = useState<SessionState>('checking');
  const [error, setError] = useState<string | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const seenMessagesRef = useRef<Set<string>>(new Set());
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Try to connect to WebSocket (session must already be running)
  const connectWebSocket = useCallback(() => {
    const wsUrl = apiClient.getWebSocketUrl(sessionId);

    wsManager.connect(sessionId, wsUrl, {
      onConnected: () => {
        if (!mountedRef.current) return;
        console.log('WebSocket connected');
        setSessionState('connected');
      },
      onDisconnected: () => {
        if (!mountedRef.current) return;
        console.log('WebSocket disconnected');
        setSessionState('disconnected');
      },
      onMessage: (message) => {
        if (!mountedRef.current) return;

        // Deduplicate messages
        const messageKey = getMessageKey(message);
        if (seenMessagesRef.current.has(messageKey)) {
          return;
        }
        seenMessagesRef.current.add(messageKey);

        const msgWithId = {
          ...message,
          localId: Math.random().toString(36).substr(2, 9),
          timestamp: Date.now(),
        };
        setMessages(prev => [...prev, msgWithId]);

        // Handle processing state
        if (message.type === 'assistant') {
          setIsProcessingLocal(true);
        } else if (message.type === 'result') {
          setIsProcessingLocal(false);
        }
      },
      onError: (err) => {
        if (!mountedRef.current) return;
        console.error('WebSocket error:', err);
        // If we get "not found or not running", session is inactive
        if (err.message.includes('not found') || err.message.includes('not running')) {
          setSessionState('inactive');
        } else {
          setError(err.message);
          setSessionState('error');
        }
      },
    });
  }, [sessionId]);

  // Start the session (calls backend to spawn Claude process)
  const handleStartSession = useCallback(async () => {
    setSessionState('starting');
    setError(null);

    try {
      console.log('Starting session:', sessionId);
      const result = await apiClient.startSession(sessionId);
      console.log('Session start result:', JSON.stringify(result));

      // Check the status
      if (result.status === 'already_running') {
        console.log('Session already running, connecting...');
      } else if (result.status === 'started') {
        console.log('Session started successfully');
        // Small delay to let the process initialize
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        console.log('Unknown status:', result.status);
      }

      if (!mountedRef.current) return;
      connectWebSocket();
    } catch (err) {
      if (!mountedRef.current) return;
      console.error('Failed to start session:', err);
      const errorMsg = err instanceof Error ? err.message : 'Failed to start session';

      // If already running, just connect
      if (errorMsg.includes('already_running') || errorMsg.includes('already running')) {
        console.log('Session already running (from error), connecting...');
        connectWebSocket();
      } else {
        setError(errorMsg);
        setSessionState('error');
      }
    }
  }, [sessionId, connectWebSocket]);

  // Initial check - try to connect, if fails session is inactive
  useEffect(() => {
    mountedRef.current = true;
    setMessages(EMPTY_MESSAGES);
    seenMessagesRef.current.clear();
    setSessionState('checking');
    setError(null);

    // Try to connect - if it fails with "not running", we know session is inactive
    connectWebSocket();

    return () => {
      mountedRef.current = false;
      wsManager.disconnect(sessionId);
      seenMessagesRef.current.clear();
    };
  }, [sessionId, connectWebSocket]);

  // Handle app state changes - reset stuck processing state when returning to foreground
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (appStateRef.current.match(/inactive|background/) && nextAppState === 'active') {
        // Returning to foreground - check if we're still actually processing
        // If not connected, we can't be processing
        if (!wsManager.isConnected(sessionId)) {
          setIsProcessingLocal(false);
        }
      }
      appStateRef.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, [sessionId]);

  // Send pending message once connected
  useEffect(() => {
    if (pendingMessage && sessionState === 'connected' && wsManager.isConnected(sessionId)) {
      const content = pendingMessage;
      setPendingMessage(null);

      // Add user message locally
      const userMessage: ChatMessageWithId = {
        type: 'user',
        message: { role: 'user', content },
        localId: Math.random().toString(36).substr(2, 9),
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, userMessage]);
      setIsProcessingLocal(true);

      const sent = wsManager.send(sessionId, content);
      if (!sent) {
        setError('Failed to send message');
        setIsProcessingLocal(false);
      }
    }
  }, [pendingMessage, sessionState, sessionId]);

  const handleSend = useCallback((content: string) => {
    // If not connected, auto-start the session
    if (!wsManager.isConnected(sessionId)) {
      if (sessionState === 'inactive' || sessionState === 'disconnected' || sessionState === 'error') {
        // Queue the message and start the session
        setPendingMessage(content);
        handleStartSession();
        return;
      }
      // If already starting or checking, just queue the message
      if (sessionState === 'starting' || sessionState === 'checking') {
        setPendingMessage(content);
        return;
      }
      setError('Not connected to server');
      return;
    }

    // Add user message locally
    const userMessage: ChatMessageWithId = {
      type: 'user',
      message: { role: 'user', content },
      localId: Math.random().toString(36).substr(2, 9),
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMessage]);
    setIsProcessingLocal(true);

    const sent = wsManager.send(sessionId, content);
    if (!sent) {
      setError('Failed to send message');
      setIsProcessingLocal(false);
    }
  }, [sessionId, sessionState, handleStartSession]);

  const handleRetry = useCallback(() => {
    setError(null);
    setSessionState('checking');
    wsManager.disconnect(sessionId);
    seenMessagesRef.current.clear();
    connectWebSocket();
  }, [sessionId, connectWebSocket]);

  const handleInterrupt = useCallback(async () => {
    try {
      await apiClient.interruptSession(sessionId);
      // Processing state will be updated when we receive the result message
    } catch (err) {
      console.error('Failed to interrupt session:', err);
      // Reset processing state anyway since interrupt failed
      setIsProcessingLocal(false);
    }
  }, [sessionId]);

  // Render based on session state
  if (sessionState === 'checking') {
    return <LoadingScreen message="Checking session status..." />;
  }

  if (sessionState === 'starting') {
    return <LoadingScreen message="Starting session..." />;
  }

  if (sessionState === 'error' && messages.length === 0) {
    return <ErrorView message={error || 'Unknown error'} onRetry={handleRetry} />;
  }

  // For inactive/disconnected states, show the input anyway so user can type and auto-start
  const isConnected = sessionState === 'connected';

  return (
    <View style={styles.container}>
      <ConnectionStatusBar connected={isConnected} />
      {(sessionState === 'inactive' || sessionState === 'disconnected') && messages.length === 0 ? (
        <View style={styles.inactiveContainer}>
          <Text style={styles.inactiveTitle}>Session Inactive</Text>
          <Text style={styles.inactiveText}>
            Type a message to start the session, or tap below.
          </Text>
          <TouchableOpacity style={styles.startButton} onPress={handleStartSession}>
            <Text style={styles.startButtonText}>Start Session</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <MessageList messages={messages} isProcessing={isProcessing} />
      )}
      <ChatInput
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        isProcessing={isProcessing}
        placeholder={
          !isConnected ? 'Type to start session...' :
          'Type a message...'
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  inactiveContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: SPACING.xl,
  },
  inactiveTitle: {
    color: COLORS.text,
    fontSize: FONT_SIZES.xl,
    fontWeight: '600',
    marginBottom: SPACING.md,
  },
  inactiveText: {
    color: COLORS.textSecondary,
    fontSize: FONT_SIZES.md,
    textAlign: 'center',
    marginBottom: SPACING.lg,
  },
  startButton: {
    backgroundColor: COLORS.accent,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    borderRadius: 8,
    marginBottom: SPACING.md,
  },
  startButtonText: {
    color: COLORS.text,
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
  },
  inactiveHint: {
    color: COLORS.textMuted,
    fontSize: FONT_SIZES.sm,
    textAlign: 'center',
    fontStyle: 'italic',
  },
});
