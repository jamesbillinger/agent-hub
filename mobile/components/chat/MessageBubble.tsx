import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { ChatMessageWithId, ContentBlock } from '../../types/chat';
import { COLORS, FONT_SIZES, SPACING } from '../../utils/constants';

interface MessageBubbleProps {
  message: ChatMessageWithId;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  if (message.type === 'user') {
    return <UserBubble content={message.message.content} />;
  }

  if (message.type === 'assistant') {
    return <AssistantBubble content={message.message.content} />;
  }

  if (message.type === 'system') {
    return <SystemBubble message={message} />;
  }

  if (message.type === 'result') {
    return <ResultBubble message={message} />;
  }

  return null;
}

function UserBubble({ content }: { content: string }) {
  return (
    <View style={styles.userContainer}>
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{content}</Text>
      </View>
    </View>
  );
}

function AssistantBubble({ content }: { content: ContentBlock[] }) {
  return (
    <View style={styles.assistantContainer}>
      {content.map((block, index) => (
        <ContentBlockRenderer key={index} block={block} />
      ))}
    </View>
  );
}

function ContentBlockRenderer({ block }: { block: ContentBlock }) {
  if (block.type === 'text') {
    return (
      <View style={styles.assistantBubble}>
        <Markdown style={markdownStyles}>{block.text}</Markdown>
      </View>
    );
  }

  if (block.type === 'tool_use') {
    return (
      <View style={styles.toolUseBubble}>
        <Text style={styles.toolUseHeader}>Tool: {block.name}</Text>
        <Text style={styles.toolUseInput} numberOfLines={5}>
          {JSON.stringify(block.input, null, 2)}
        </Text>
      </View>
    );
  }

  if (block.type === 'tool_result') {
    return (
      <View style={[styles.toolResultBubble, block.is_error && styles.toolResultError]}>
        <Text style={styles.toolResultHeader}>
          {block.is_error ? 'Error' : 'Result'}
        </Text>
        <Text style={styles.toolResultContent} numberOfLines={10}>
          {block.content}
        </Text>
      </View>
    );
  }

  return null;
}

function SystemBubble({ message }: { message: ChatMessageWithId }) {
  if (message.type !== 'system') return null;

  let text = '';
  if (message.subtype === 'init') {
    text = `Session started${message.model ? ` (${message.model})` : ''}`;
  } else if (message.subtype === 'error') {
    text = message.message || 'An error occurred';
  } else {
    text = message.message || 'System message';
  }

  return (
    <View style={styles.systemContainer}>
      <Text style={[styles.systemText, message.subtype === 'error' && styles.systemError]}>
        {text}
      </Text>
    </View>
  );
}

function ResultBubble({ message }: { message: ChatMessageWithId }) {
  if (message.type !== 'result') return null;

  const parts = [];
  if (message.duration_ms) {
    parts.push(`${(message.duration_ms / 1000).toFixed(1)}s`);
  }
  if (message.total_cost_usd) {
    parts.push(`$${message.total_cost_usd.toFixed(4)}`);
  }

  if (parts.length === 0) return null;

  return (
    <View style={styles.resultContainer}>
      <Text style={styles.resultText}>{parts.join(' | ')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  userContainer: {
    alignItems: 'flex-end',
    marginVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
  },
  userBubble: {
    backgroundColor: COLORS.userBubble,
    borderRadius: 16,
    borderBottomRightRadius: 4,
    padding: SPACING.md,
    maxWidth: '85%',
  },
  userText: {
    color: COLORS.text,
    fontSize: FONT_SIZES.md,
    lineHeight: 22,
  },
  assistantContainer: {
    alignItems: 'flex-start',
    marginVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
  },
  assistantBubble: {
    backgroundColor: COLORS.assistantBubble,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    padding: SPACING.md,
    maxWidth: '90%',
  },
  toolUseBubble: {
    backgroundColor: COLORS.toolUse,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accent,
    padding: SPACING.md,
    maxWidth: '90%',
    marginVertical: SPACING.xs,
  },
  toolUseHeader: {
    color: COLORS.accent,
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
    marginBottom: SPACING.xs,
  },
  toolUseInput: {
    color: COLORS.textSecondary,
    fontSize: FONT_SIZES.xs,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  toolResultBubble: {
    backgroundColor: COLORS.backgroundTertiary,
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.success,
    padding: SPACING.md,
    maxWidth: '90%',
    marginVertical: SPACING.xs,
  },
  toolResultError: {
    borderLeftColor: COLORS.error,
  },
  toolResultHeader: {
    color: COLORS.textSecondary,
    fontSize: FONT_SIZES.xs,
    fontWeight: '600',
    marginBottom: SPACING.xs,
  },
  toolResultContent: {
    color: COLORS.textSecondary,
    fontSize: FONT_SIZES.xs,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  systemContainer: {
    alignItems: 'center',
    marginVertical: SPACING.sm,
    paddingHorizontal: SPACING.lg,
  },
  systemText: {
    color: COLORS.textMuted,
    fontSize: FONT_SIZES.sm,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  systemError: {
    color: COLORS.error,
  },
  resultContainer: {
    alignItems: 'center',
    marginVertical: SPACING.xs,
    paddingHorizontal: SPACING.lg,
  },
  resultText: {
    color: COLORS.textMuted,
    fontSize: FONT_SIZES.xs,
  },
});

// Need Platform for font family
import { Platform } from 'react-native';

const markdownStyles = {
  body: {
    color: COLORS.text,
    fontSize: FONT_SIZES.md,
    lineHeight: 22,
  },
  heading1: {
    color: COLORS.text,
    fontSize: FONT_SIZES.xl,
    fontWeight: 'bold' as const,
    marginVertical: SPACING.sm,
  },
  heading2: {
    color: COLORS.text,
    fontSize: FONT_SIZES.lg,
    fontWeight: 'bold' as const,
    marginVertical: SPACING.sm,
  },
  heading3: {
    color: COLORS.text,
    fontSize: FONT_SIZES.md,
    fontWeight: 'bold' as const,
    marginVertical: SPACING.xs,
  },
  code_inline: {
    backgroundColor: COLORS.backgroundTertiary,
    color: COLORS.accent,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: FONT_SIZES.sm,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  code_block: {
    backgroundColor: COLORS.backgroundTertiary,
    color: COLORS.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: FONT_SIZES.sm,
    padding: SPACING.md,
    borderRadius: 8,
    marginVertical: SPACING.sm,
  },
  fence: {
    backgroundColor: COLORS.backgroundTertiary,
    color: COLORS.text,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: FONT_SIZES.sm,
    padding: SPACING.md,
    borderRadius: 8,
    marginVertical: SPACING.sm,
  },
  link: {
    color: COLORS.accent,
  },
  blockquote: {
    backgroundColor: COLORS.backgroundTertiary,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.accent,
    paddingLeft: SPACING.md,
    marginVertical: SPACING.sm,
  },
  list_item: {
    marginVertical: 2,
  },
  bullet_list: {
    marginVertical: SPACING.xs,
  },
  ordered_list: {
    marginVertical: SPACING.xs,
  },
};
