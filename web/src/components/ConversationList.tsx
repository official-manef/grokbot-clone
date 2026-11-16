import { useEffect, useRef, useState } from 'react';
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

  /** Replace one row's title in place, so the list does not reload for a rename. */
  const setTitle = (generation: number, title: string, source: Conversation['source']) => {
    setItems((list) => (list ?? []).map((c) => (c.generation === generation ? { ...c, title, source } : c)));
  };

  return (
    <div className="menu menu--list is-left" role="dialog" aria-label="Conversation history">
      <div className="menu__header">Conversation history</div>
      {error && <div className="menu__empty" role="alert">{error}</div>}
      {!error && items === null && <div className="menu__empty">Loading…</div>}
      {!error && items?.length === 0 && <div className="menu__empty">No conversations yet.</div>}
      {items?.map((c) => (
        <Row
          key={c.generation}
          conversation={c}
          isCurrent={c.generation === current}
          busy={busy === c.generation}
          disabled={busy !== null}
          onOpen={() => void open(c.generation)}
          onRenamed={(title, source) => setTitle(c.generation, title, source)}
          onError={setError}
          botId={botId}
        />
      ))}
      {transcript?.generation !== current && current !== null && (
        <button type="button" className="menu__item" onClick={() => void open(current)}>
          <span>Back to the current chat</span>
        </button>
      )}
    </div>
  );
}

/**
 * One row: opens on click, renames on the pencil (or F2).
 *
 * A rename is an inline input rather than a modal: the row is the thing being
 * named, and a dialog would hide which conversation is being changed. Escape
 * cancels, Enter saves, and an empty save clears the title so the fallback returns —
 * that is what the server does with an empty body, and it is the only way back to
 * an automatic name once it has been overwritten.
 */
function Row({
  conversation: c,
  isCurrent,
  busy,
  disabled,
  onOpen,
  onRenamed,
  onError,
  botId,
}: {
  conversation: Conversation;
  isCurrent: boolean;
  busy: boolean;
  disabled: boolean;
  onOpen: () => void;
  onRenamed: (title: string, source: Conversation['source']) => void;
  onError: (message: string | null) => void;
  botId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.title);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing) input.current?.select(); }, [editing]);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api.renameConversation(botId, c.generation, draft);
      onRenamed(saved.title, saved.source as Conversation['source']);
      onError(null);
      setEditing(false);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not rename that conversation');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="menu__item menu__item--row is-editing">
        <input
          ref={input}
          value={draft}
          aria-label={`Rename ${c.title || `chat ${c.generation}`}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') { setDraft(c.title); setEditing(false); }
            e.stopPropagation();
          }}
          className="menu__rename-input"
        />
        <span className="menu__hint">{saving ? 'Saving…' : '↵ save · esc cancel'}</span>
      </div>
    );
  }

  return (
    <div
      className={`menu__item menu__item--row${isCurrent ? ' is-current' : ''}`}
      aria-current={isCurrent ? 'true' : undefined}
      onKeyDown={(e) => { if (e.key === 'F2') { setDraft(c.title); setEditing(true); } }}
    >
      <button
        type="button"
        className="menu__item-main"
        onClick={onOpen}
        disabled={disabled}
      >
        <span className="menu__item-title">{c.title || `Chat ${c.generation}`}</span>
      </button>
      <button
        type="button"
        className="menu__rename"
        aria-label={`Rename ${c.title || `chat ${c.generation}`}`}
        title="Rename"
        disabled={disabled || saving}
        onClick={() => { setDraft(c.title); setEditing(true); }}
      >
        ✎
      </button>
      <span className="menu__hint">
        {busy ? 'Opening…' : isCurrent ? 'Current' : new Date(c.updatedAt).toLocaleDateString()}
      </span>
    </div>
  );
}
