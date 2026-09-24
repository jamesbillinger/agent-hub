import type { Message } from '../types';

/**
 * Mirrors the desktop's activity rollup (src/main.ts): everything between two
 * things the user actually reads - tool calls, subagent output, thinking-only
 * turns - folds into one "activity" row. The newest group is the live tail
 * and stays open so streaming output is always visible.
 */

export type Altitude = 'readable' | 'activity' | 'hidden';

export function messageAltitude(message: Message): Altitude {
  if (message.type === 'user') {
    const content = message.result ?? message.message?.content;
    // A string is what the user typed; an array is either text/image blocks
    // (readable) or tool results (never shown).
    const hasText = typeof content === 'string'
      ? content.trim().length > 0
      : Array.isArray(content) && content.some((b) => (b.type === 'text' && !!b.text?.trim()) || b.type === 'image');
    return hasText || (message.images?.length ?? 0) > 0 ? 'readable' : 'hidden';
  }
  if (message.type === 'assistant') {
    const content = message.message?.content;
    if (!Array.isArray(content)) return 'hidden';
    // Subagent output sits a level below even the main agent's tool calls
    if (message.parent_tool_use_id) return 'activity';
    let hasText = false;
    let hasTool = false;
    for (const block of content) {
      if ((block.type === 'text' && block.text?.trim()) || block.type === 'image') hasText = true;
      else if (block.type === 'tool_use') {
        if (block.name === 'AskUserQuestion' || block.name === 'ExitPlanMode') return 'readable';
        if (block.name !== 'TodoWrite') hasTool = true;
      }
    }
    if (hasText) return 'readable';
    return hasTool ? 'activity' : 'hidden';
  }
  if (message.type === 'result') return message.is_error && message.result ? 'readable' : 'hidden';
  if (message.type === 'system') {
    if (message.subtype === 'init') return 'readable';
    if (message.subtype === 'resumed' || message.subtype === 'stopped' || message.subtype === 'compact_boundary') return 'readable';
    if (message.subtype === 'status') return 'hidden';
    return message.result ? 'readable' : 'hidden';
  }
  return 'hidden';
}

export function messageAt(message: Message): number | null {
  if (typeof message.received_at === 'number') return message.received_at;
  if (typeof message.timestamp === 'string') {
    const t = Date.parse(message.timestamp);
    if (!isNaN(t)) return t;
  }
  return null;
}

export interface ActivitySummary {
  tools: number;
  toolCounts: Map<string, number>;
  subagents: number;
  edits: number;
  errors: number;
  elapsedMs: number | null;
}

export type ListItem =
  | { kind: 'message'; key: string; message: Message }
  | { kind: 'activity'; key: string; messages: Message[]; summary: ActivitySummary; isTail: boolean };

export function itemKey(message: Message, index: number): string {
  return message.uuid ?? `i${index}`;
}

function summarize(messages: Message[]): ActivitySummary {
  const toolCounts = new Map<string, number>();
  const subagents = new Set<string>();
  const edits = new Set<string>();
  let errors = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  for (const m of messages) {
    const at = messageAt(m);
    if (at !== null) {
      if (firstAt === null) firstAt = at;
      lastAt = at;
    }
    if (m.parent_tool_use_id) subagents.add(m.parent_tool_use_id);
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block.type !== 'tool_use' || !block.name) continue;
        toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
        if ((block.name === 'Edit' || block.name === 'Write' || block.name === 'NotebookEdit') && !m.parent_tool_use_id) {
          const input = block.input as { file_path?: string; notebook_path?: string } | undefined;
          const path = input?.file_path ?? input?.notebook_path;
          if (path) edits.add(path);
        }
      }
    } else if (m.type === 'result' && m.is_error) {
      errors++;
    }
  }
  let tools = 0;
  for (const n of toolCounts.values()) tools += n;
  return {
    tools,
    toolCounts,
    subagents: subagents.size,
    edits: edits.size,
    errors,
    elapsedMs: firstAt !== null && lastAt !== null && lastAt > firstAt ? lastAt - firstAt : null,
  };
}

/**
 * Fold a session's messages into list rows. With `expanded` every message is
 * its own row (the "show all activity" mode). Group keys are the first
 * message's key, so a group keeps its identity as the tail grows.
 */
export function groupMessages(messages: Message[], expanded: boolean): ListItem[] {
  const items: ListItem[] = [];
  let run: Message[] = [];
  let runKey = '';
  const flush = (isTail: boolean) => {
    if (run.length === 0) return;
    items.push({ kind: 'activity', key: `act:${runKey}`, messages: run, summary: summarize(run), isTail });
    run = [];
  };
  messages.forEach((message, index) => {
    const altitude = messageAltitude(message);
    if (altitude === 'hidden') return;
    if (altitude === 'activity' && !expanded) {
      if (run.length === 0) runKey = itemKey(message, index);
      run.push(message);
      return;
    }
    flush(false);
    items.push({ kind: 'message', key: itemKey(message, index), message });
  });
  flush(true);
  return items;
}

/** Index of the row that shows this message, whether directly or inside a group. */
export function findItemIndex(items: ListItem[], uuid: string): number {
  return items.findIndex((it) =>
    it.kind === 'message' ? it.message.uuid === uuid : it.messages.some((m) => m.uuid === uuid),
  );
}

export function formatElapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
}
