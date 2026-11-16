import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { Conversation } from '@shared/types';
import { useStore } from '../store';

/**
 * The conversations a bot has had, and the way back into one.
 *
 * "New conversation" already existed: it bumps the bot's generation and starts a
 * fresh Hermes thread. What it lacked was a way back, so pressing it felt like
 * deleting the chat. Every generation still has its rows; this is the index.
 *
 * Titles come from `GET /bots/:id/conversations`, which falls back to the first
 * message for any conversation that was never named, so an old chat is listed under
 * something recognisable rather than as "Untitled".
 */
export function ConversationList({ botId, onClose }: { botId: string; onClose: () => void }) {
  const [items, setItems] = useState<Conversation[] | null>(null);
  const [current, setCurrent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const transcript = useStore((s) => s.transcripts[botId]);

  useEffect(() => {
    let live = true;
    api.conversations(botId)
      .then(({ current: gen, conversations }) => {
        if (!live) return;
        setItems(conversations);
        setCurrent(gen);
      })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : 'Could not load conversations'); });
    return () => { live = false; };
  }, [botId]);

  const open = async (generation: number) => {
    if (generation === current) { onClose(); return; }
    setBusy(generation);
    try {
      // Read-only view of a past conversation: the composer still writes to the
      // CURRENT generation, so this never risks mixing two threads together.
      const { generation: gen, rows } = await api.rowsOf(botId, generation);
      const bySeq: Record<number, (typeof rows)[number]> = {};
      for (const r of rows) bySeq[r.seq] = r;
      useStore.setState((s) => ({ transcripts: { ...s.transcripts, [botId]: { generation: gen, bySeq, loaded: true } } }));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open that conversation');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="menu menu--list is-left" role="dialog" aria-label="Conversation history">
      <div className="menu__header">Conversation history</div>
      {error && <div className="menu__empty" role="alert">{error}</div>}
      {!error && items === null && <div className="menu__empty">Loading…</div>}
      {!error && items?.length === 0 && <div className="menu__empty">No conversations yet.</div>}
      {items?.map((c) => (
        <button
          key={c.generation}
          type="button"
          className={`menu__item menu__item--row${c.generation === current ? ' is-current' : ''}`}
          onClick={() => void open(c.generation)}
          disabled={busy !== null}
          aria-current={c.generation === current ? 'true' : undefined}
        >
          <span className="menu__item-title">{c.title || `Chat ${c.generation}`}</span>
          <span className="menu__hint">
            {busy === c.generation ? 'Opening…' : c.generation === current ? 'Current' : new Date(c.updatedAt).toLocaleDateString()}
          </span>
        </button>
      ))}
      {transcript?.generation !== current && current !== null && (
        <button type="button" className="menu__item" onClick={() => void open(current)}>
          <span>Back to the current chat</span>
        </button>
      )}
    </div>
  );
}
