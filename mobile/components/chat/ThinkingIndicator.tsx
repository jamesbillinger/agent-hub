import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { COLORS, FONT_SIZES, SPACING } from '../../utils/constants';

interface ThinkingIndicatorProps {
  visible: boolean;
}

export function ThinkingIndicator({ visible }: ThinkingIndicatorProps) {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) return;

    const animate = (dot: Animated.Value, delay: number) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, {
            toValue: 1,
            duration: 300,
            easing: Easing.ease,
            useNativeDriver: true,
          }),
          Animated.timing(dot, {
            toValue: 0,
            duration: 300,
            easing: Easing.ease,
            useNativeDriver: true,
          }),
        ])
      );
    };

    const a1 = animate(dot1, 0);
    const a2 = animate(dot2, 150);
    const a3 = animate(dot3, 300);

    a1.start();
    a2.start();
    a3.start();

    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, [visible, dot1, dot2, dot3]);

  if (!visible) return null;

  const dotStyle = (animation: Animated.Value) => ({
    opacity: animation.interpolate({
      inputRange: [0, 1],
      outputRange: [0.3, 1],
    }),
    transform: [
      {
        scale: animation.interpolate({
          inputRange: [0, 1],
          outputRange: [1, 1.2],
        }),
      },
    ],
  });

  return (
    <View style={styles.container}>
      <View style={styles.bubble}>
        <Text style={styles.text}>Claude is thinking</Text>
        <View style={styles.dots}>
          <Animated.View style={[styles.dot, dotStyle(dot1)]} />
          <Animated.View style={[styles.dot, dotStyle(dot2)]} />
          <Animated.View style={[styles.dot, dotStyle(dot3)]} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'flex-start',
    marginVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
  },
  bubble: {
    backgroundColor: COLORS.assistantBubble,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    flexDirection: 'row',
    alignItems: 'center',
  },
  text: {
    color: COLORS.textSecondary,
    fontSize: FONT_SIZES.sm,
    fontStyle: 'italic',
    marginRight: SPACING.sm,
  },
  dots: {
    flexDirection: 'row',
    gap: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accent,
  },
});
