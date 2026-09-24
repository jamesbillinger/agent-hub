import { useMemo } from 'react';
import { MessageBubble } from './MessageBubble';
import { formatElapsed, type ActivitySummary } from '../../utils/activity';
import type { Message } from '../../types';

interface ActivityGroupProps {
  messages: Message[];
  summary: ActivitySummary;
  open: boolean;
  onToggle: () => void;
  flashUuid: string | null;
}

/**
 * One folded run of tool calls / subagent output. Collapsed, it's a single
 * summary line; open, it lists the messages with each subagent run nested
 * under its own disclosure.
 */
export function ActivityGroup({ messages, summary, open, onToggle, flashUuid }: ActivityGroupProps) {
  const parts: string[] = [];
  parts.push(`${summary.tools} tool call${summary.tools === 1 ? '' : 's'}`);
  if (summary.subagents) parts.push(`${summary.subagents} subagent${summary.subagents === 1 ? '' : 's'}`);
  if (summary.edits) parts.push(`✎ ${summary.edits} file${summary.edits === 1 ? '' : 's'}`);
  if (summary.elapsedMs !== null) parts.push(formatElapsed(summary.elapsedMs));
  const top = [...summary.toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(', ');

  // Main-agent messages stay in order; each subagent run collects under one row.
  const rows = useMemo(() => {
    if (!open) return [];
    const out: Array<{ kind: 'msg'; message: Message } | { kind: 'run'; id: string; messages: Message[] }> = [];
    const runs = new Map<string, Message[]>();
    for (const m of messages) {
      const run = m.parent_tool_use_id;
      if (!run) {
        out.push({ kind: 'msg', message: m });
        continue;
      }
      let list = runs.get(run);
      if (!list) {
        list = [];
        runs.set(run, list);
        out.push({ kind: 'run', id: run, messages: list });
      }
      list.push(m);
    }
    return out;
  }, [messages, open]);

  return (
    <div className={`ah-activity ${open ? 'open' : ''}`}>
      <button type="button" className="ah-activity-header" onClick={onToggle}>
        <span className="ah-activity-caret">{open ? '▾' : '▸'}</span>
        <span className="ah-activity-summary">
          {parts.join(' · ')}
          {summary.errors > 0 && (
            <span className="ah-activity-errors"> · ⚠ {summary.errors} error{summary.errors === 1 ? '' : 's'}</span>
          )}
        </span>
        {top && <span className="ah-activity-tools">{top}</span>}
      </button>
      {open && (
        <div className="ah-activity-body">
          {rows.map((row) =>
            row.kind === 'msg' ? (
              <div
                key={row.message.uuid ?? row.message.message?.id}
                data-uuid={row.message.uuid}
                className={row.message.uuid && row.message.uuid === flashUuid ? 'ah-search-flash' : undefined}
              >
                <MessageBubble message={row.message} />
              </div>
            ) : (
              <details key={row.id} className="ah-subagent-run">
                <summary>
                  Subagent · {row.messages.length} message{row.messages.length === 1 ? '' : 's'}
                </summary>
                {row.messages.map((m, i) => (
                  <div
                    key={m.uuid ?? i}
                    data-uuid={m.uuid}
                    className={m.uuid && m.uuid === flashUuid ? 'ah-search-flash' : undefined}
                  >
                    <MessageBubble message={m} />
                  </div>
                ))}
              </details>
            ),
          )}
        </div>
      )}
    </div>
  );
}
