import { useEffect, useRef, useState } from 'react';
import { useGlobalStore } from '../../stores';
import { api, type SearchHit } from '../../services/api';

interface SearchPanelProps {
  onClose: () => void;
}

export function SearchPanel({ onClose }: SearchPanelProps) {
  const setActiveSession = useGlobalStore((s) => s.setActiveSession);
  const setPendingScrollTarget = useGlobalStore((s) => s.setPendingScrollTarget);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const seqRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus on open
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced search
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
        const res = await api.searchMessages({ q, limit: 50 });
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
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#1a1a1a] flex flex-col pt-[env(safe-area-inset-top)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#3c3c3c]">
        <button
          onClick={onClose}
          className="p-2 text-gray-400 hover:text-white"
          aria-label="Close search"
        >
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
          <button
            onClick={() => setQuery('')}
            className="p-2 text-gray-400 hover:text-white"
            aria-label="Clear"
          >
            ×
          </button>
        )}
      </div>

      {/* Hint / status row */}
      <div className="px-4 py-2 text-xs text-gray-500 border-b border-[#2a2a2a]">
        {query.trim().length < 3
          ? 'Type at least 3 characters to search across all messages.'
          : loading
          ? 'Searching…'
          : err
          ? `Error: ${err}`
          : hits
          ? `${hits.length} match${hits.length === 1 ? '' : 'es'}`
          : ''}
      </div>

      {/* Hit list */}
      <div className="flex-1 overflow-y-auto">
        {hits && hits.length === 0 && !loading && !err && (
          <div className="px-4 py-8 text-center text-gray-500 text-sm italic">
            No matches for “{query}”
          </div>
        )}
        {hits && hits.map((hit) => (
          <SearchHitRow key={hit.message_id} hit={hit} onTap={() => handleHitTap(hit)} />
        ))}
      </div>
    </div>
  );
}

function SearchHitRow({ hit, onTap }: { hit: SearchHit; onTap: () => void }) {
  const roleColor =
    hit.role === 'user' ? 'text-green-400' :
    hit.role === 'assistant' ? 'text-blue-400' :
    'text-gray-500';

  return (
    <button
      onClick={onTap}
      className="w-full text-left px-4 py-3 border-b border-[#2a2a2a] hover:bg-[#2a2a2a] active:bg-[#333]"
    >
      <div className="flex items-baseline gap-2 mb-1 text-xs">
        <span className="font-semibold text-white truncate flex-1">
          {hit.session_name || '(unnamed)'}
        </span>
        <span className={`uppercase tracking-wide ${roleColor}`}>{hit.role}</span>
        {hit.ts > 0 && (
          <span className="text-gray-500">{formatRelative(hit.ts)}</span>
        )}
      </div>
      <div
        className="text-sm text-gray-300 line-clamp-2 break-words"
        // The server-built snippet wraps matches in <mark>…</mark>; the
        // rest is plain text from search_text (no html).
        dangerouslySetInnerHTML={{ __html: hit.snippet }}
      />
    </button>
  );
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
