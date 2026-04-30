import { useEffect, useMemo, useRef, useState } from 'react';
import { useGlobalStore } from '../../stores';
import { api, type SearchHit, type MessageContext, type ContextEntry } from '../../services/api';

interface SearchPanelProps {
  onClose: () => void;
  initialQuery?: string;
}

export function SearchPanel({ onClose, initialQuery }: SearchPanelProps) {
  const setActiveSession = useGlobalStore((s) => s.setActiveSession);
  const setPendingScrollTarget = useGlobalStore((s) => s.setPendingScrollTarget);
  const rememberSearchQuery = useGlobalStore((s) => s.rememberSearchQuery);

  const [query, setQuery] = useState(initialQuery ?? '');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const seqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setHits(null);
      setErr(null);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setErr(null);
    const t = window.setTimeout(async () => {
      try {
        const res = await api.searchMessages({ q, limit: 100 });
        if (seq === seqRef.current) {
          setHits(res.hits);
          setLoading(false);
        }
      } catch (e) {
        if (seq === seqRef.current) {
          setErr(e instanceof Error ? e.message : String(e));
          setHits([]);
          setLoading(false);
        }
      }
    }, 220);
    return () => window.clearTimeout(t);
  }, [query]);

  const handleHitTap = (hit: SearchHit) => {
    setPendingScrollTarget(hit.uuid);
    setActiveSession(hit.session_id);
    // Mark the back-trail AFTER setActiveSession (which clears it by default).
    // ChatView reads cameFromSearch to decide whether to show the pill.
    rememberSearchQuery(query.trim());
    onClose();
  };

  // Group hits by session_id, preserving rank order within each.
  const groups = useMemo(() => {
    if (!hits) return [];
    const map = new Map<string, { name: string; items: SearchHit[] }>();
    for (const hit of hits) {
      const key = hit.session_id;
      if (!map.has(key)) {
        map.set(key, { name: hit.session_name || '(unnamed)', items: [] });
      }
      map.get(key)!.items.push(hit);
    }
    return Array.from(map.entries()).map(([id, v]) => ({ id, ...v }));
  }, [hits]);

  return (
    <div className="fixed inset-0 z-50 bg-[#1a1a1a] flex flex-col pt-[env(safe-area-inset-top)]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#3c3c3c]">
        <button onClick={onClose} className="p-2 text-gray-400 hover:text-white" aria-label="Close search">
          ←
        </button>
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations…"
          className="flex-1 px-3 py-2 bg-[#2a2a2a] border border-[#3c3c3c] rounded text-white placeholder-gray-500 focus:outline-none focus:border-[#0e9fd8]"
        />
        {query && (
          <button onClick={() => setQuery('')} className="p-2 text-gray-400 hover:text-white" aria-label="Clear">
            ×
          </button>
        )}
      </div>

      <div className="px-4 py-2 text-xs text-gray-500 border-b border-[#2a2a2a]">
        {query.trim().length < 3
          ? 'Type at least 3 characters to search across all messages.'
          : loading ? 'Searching…'
          : err ? `Error: ${err}`
          : hits ? `${hits.length} match${hits.length === 1 ? '' : 'es'} across ${groups.length} session${groups.length === 1 ? '' : 's'}`
          : ''}
      </div>

      <div className="flex-1 overflow-y-auto">
        {hits && hits.length === 0 && !loading && !err && (
          <div className="px-4 py-8 text-center text-gray-500 text-sm italic">
            No matches for &ldquo;{query}&rdquo;
          </div>
        )}
        {groups.map((group) => (
          <SessionGroup key={group.id} name={group.name} items={group.items} onTap={handleHitTap} />
        ))}
      </div>
    </div>
  );
}

function SessionGroup({
  name, items, onTap,
}: { name: string; items: SearchHit[]; onTap: (h: SearchHit) => void }) {
  const latestTs = items.reduce((m, h) => (h.ts > m ? h.ts : m), 0);
  const latest = latestTs > 0 ? formatHitDate(latestTs) : null;
  return (
    <div className="border-t border-[#2a2a2a] mt-2">
      <div className="sticky top-0 z-10 px-4 py-2 text-xs font-semibold text-white uppercase tracking-wider bg-[#222] flex items-baseline gap-2 border-b border-[#2a2a2a]">
        <span className="truncate flex-1">{name}</span>
        {latest && <span className="text-gray-500 font-normal normal-case tracking-normal" title={latest.full}>latest: {latest.short}</span>}
        <span className="text-gray-500 font-normal normal-case tracking-normal">{items.length} hit{items.length === 1 ? '' : 's'}</span>
      </div>
      {items.map((hit) => (
        <SearchHitCard key={hit.message_id} hit={hit} onTap={() => onTap(hit)} />
      ))}
    </div>
  );
}

function SearchHitCard({ hit, onTap }: { hit: SearchHit; onTap: () => void }) {
  const [ctx, setCtx] = useState<MessageContext | null>(null);
  const cardRef = useRef<HTMLButtonElement>(null);

  // Lazy load context the first time the card scrolls into view.
  useEffect(() => {
    if (!cardRef.current) return;
    const node = cardRef.current;
    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          io.disconnect();
          api.getMessageContext({ message_id: hit.message_id, before: 2, after: 2 })
            .then((c) => { if (!cancelled) setCtx(c); })
            .catch(() => {});
          break;
        }
      }
    }, { rootMargin: '300px' });
    io.observe(node);
    return () => { cancelled = true; io.disconnect(); };
  }, [hit.message_id]);

  const roleColor =
    hit.role === 'user' ? 'text-green-400' :
    hit.role === 'assistant' ? 'text-blue-400' :
    'text-gray-500';

  return (
    <button
      ref={cardRef}
      onClick={onTap}
      className="w-full text-left px-4 py-3 border-t border-[#2a2a2a] hover:bg-[#2a2a2a] active:bg-[#333]"
    >
      <div className="flex items-baseline gap-2 text-xs mb-2">
        <span className={`uppercase tracking-wide font-semibold ${roleColor}`}>{hit.role}</span>
        {hit.ts > 0 && (() => {
          const d = formatHitDate(hit.ts);
          return <span className="text-gray-500" title={d.full}>{d.short}</span>;
        })()}
        {ctx?.hit && <span className="text-gray-500">msg {ctx.hit.turn_index}</span>}
      </div>
      <div className="flex flex-col gap-1">
        {ctx ? (
          <>
            {ctx.before.filter(isMeaningful).map((e) => <ContextLine key={`b-${e.uuid}`} entry={e} highlight={false} />)}
            {ctx.hit && <HitLine hit={hit} entry={ctx.hit} />}
            {ctx.after.filter(isMeaningful).map((e) => <ContextLine key={`a-${e.uuid}`} entry={e} highlight={false} />)}
          </>
        ) : (
          <HitLine hit={hit} entry={null} />
        )}
      </div>
      <div className="mt-2 text-xs text-blue-400">Open in session →</div>
    </button>
  );
}

function ContextLine({ entry, highlight }: { entry: ContextEntry; highlight: boolean }) {
  const text = extractText(entry.message);
  return (
    <div className={`flex gap-2 items-baseline px-2 py-1 rounded text-xs ${
      highlight ? 'bg-blue-500/15 text-white' : 'bg-white/[0.02] text-gray-400'
    }`}>
      <span className="text-[10px] uppercase tracking-wide text-gray-500 min-w-[64px] pt-0.5">{entry.role}</span>
      <span className="flex-1 whitespace-pre-wrap break-words line-clamp-3">{text || '(empty)'}</span>
    </div>
  );
}

function isMeaningful(entry: ContextEntry): boolean {
  return extractText(entry.message).trim().length > 0;
}

function HitLine({ hit, entry }: { hit: SearchHit; entry: ContextEntry | null }) {
  // Use the server-side snippet (which has <mark>) when we don't have full
  // context yet, then upgrade to the full message text once context arrives.
  return (
    <div className="flex gap-2 items-baseline px-2 py-1 rounded text-xs bg-blue-500/15 text-white">
      <span className="text-[10px] uppercase tracking-wide text-gray-300 min-w-[64px] pt-0.5">{hit.role}</span>
      {entry ? (
        <span className="flex-1 whitespace-pre-wrap break-words">
          {extractText(entry.message) || '(empty)'}
        </span>
      ) : (
        <span
          className="flex-1 whitespace-pre-wrap break-words"
          // server snippet wraps matches in <mark>
          dangerouslySetInnerHTML={{ __html: hit.snippet }}
        />
      )}
    </div>
  );
}

function extractText(msg: Record<string, unknown>): string {
  if (!msg || typeof msg !== 'object') return '';
  const inner = (msg as any).message;
  if (typeof inner?.content === 'string') return inner.content;
  if (Array.isArray(inner?.content)) {
    const parts: string[] = [];
    for (const block of inner.content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block?.type === 'thinking' && typeof block.thinking === 'string') parts.push(block.thinking);
      else if (block?.type === 'tool_use') {
        const name = block.name ?? 'tool_use';
        const input = block.input ? JSON.stringify(block.input) : '';
        parts.push(input ? `${name}: ${input.length > 80 ? input.slice(0, 80) + '…' : input}` : name);
      }
      // tool_result and image blocks: skipped on purpose. tool_results are
      // the CLI's wire wrapping for tool output; not user-meaningful here.
    }
    return parts.join('\n');
  }
  if (typeof (msg as any).content === 'string') return (msg as any).content;
  if ((msg as any).attachment?.type) return `[${(msg as any).attachment.type}]`;
  return '';
}

function formatHitDate(ms: number): { short: string; full: string } {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const sameYear = d.getFullYear() === now.getFullYear();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  let short: string;
  if (sameDay) short = `today ${time}`;
  else if (isYesterday) short = `yesterday ${time}`;
  else if ((now.getTime() - ms) < 7 * 86_400_000) {
    short = `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  } else if (sameYear) {
    short = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } else {
    short = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  return { short, full: d.toLocaleString() };
}
