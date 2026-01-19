import React, { useRef, useEffect } from 'react';
import { StyleSheet, View, FlatList } from 'react-native';
import { ChatMessageWithId } from '../../types/chat';
import { MessageBubble } from './MessageBubble';
import { ThinkingIndicator } from './ThinkingIndicator';
import { COLORS, SPACING } from '../../utils/constants';

interface MessageListProps {
  messages: ChatMessageWithId[];
  isProcessing: boolean;
}

export function MessageList({ messages, isProcessing }: MessageListProps) {
  const listRef = useRef<FlatList<ChatMessageWithId>>(null);

  useEffect(() => {
    // Scroll to bottom when new messages arrive
    if (messages.length > 0) {
      setTimeout(() => {
        listRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages.length, isProcessing]);

  const renderItem = ({ item }: { item: ChatMessageWithId }) => (
    <MessageBubble message={item} />
  );

  return (
    <View style={styles.container}>
      <FlatList
        ref={listRef}
        data={messages}
        renderItem={renderItem}
        keyExtractor={item => item.localId}
        contentContainerStyle={styles.listContent}
        ListFooterComponent={
          isProcessing ? <ThinkingIndicator visible={true} /> : null
        }
        onContentSizeChange={() => {
          listRef.current?.scrollToEnd({ animated: true });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  listContent: {
    paddingVertical: SPACING.sm,
  },
});
