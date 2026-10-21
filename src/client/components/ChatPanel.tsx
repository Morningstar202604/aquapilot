import { useEffect, useRef, useState } from 'react';
import type { ChatEntry } from '../hooks/useSimulation';
import type { Answer } from '../../ai/agent';

interface Props {
  chat: ChatEntry[];
  onAsk: (text: string) => void;
  connected: boolean;
}

const SUGGESTIONS = ['现在运行怎么样', '为什么这样调节', '如果发生暴雨会怎样', '给我未来 8 小时计划'];

export function ChatPanel({ chat, onAsk, connected }: Props) {
  const [draft, setDraft] = useState('');
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onAsk(text);
    setDraft('');
  };

  return (
    <div className="side-body">
      <div className="chat-log" ref={logRef} aria-live="polite">
        {chat.length === 0 && (
          <div className="chat-empty">
            <strong>AI 值班员在岗。</strong>
            <br />
            全厂控制已交由 AI 接管，你只需要提问或下指令。它会解释每一次调节的依据，也可以帮你做假设推演。
          </div>
        )}
        {chat.map((entry) => (
          <Message key={entry.id} entry={entry} />
        ))}
      </div>
      <div className="chat-chips">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip" onClick={() => onAsk(s)} disabled={!connected}>
            {s}
          </button>
        ))}
      </div>
      <div className="composer">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder={connected ? '问 AI：现在怎么样、为什么、如果……' : '连接中…'}
          aria-label="向 AI 值班员提问"
          disabled={!connected}
        />
        <button className="send-btn" onClick={submit} disabled={!connected || !draft.trim()} aria-label="发送">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M2 8h11M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function Message({ entry }: { entry: ChatEntry }) {
  if (entry.role === 'user') {
    return (
      <div className="msg" data-role="user">
        <div className="msg-user-bubble">{entry.text}</div>
      </div>
    );
  }
  const answer = entry.answer as Answer | undefined;
  if (!answer) return null;
  return (
    <div className="msg">
      <div className="msg-ai">
        <div className="msg-ai-title">{answer.title}</div>
        <div className="msg-ai-body">{answer.body}</div>
        {answer.bullets.length > 0 && (
          <ul className="msg-bullets">
            {answer.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        )}
        <div className="msg-confidence">
          <span>置信度</span>
          <span className="conf-track">
            <span style={{ width: `${Math.round(answer.confidence * 100)}%` }} />
          </span>
          <span>{Math.round(answer.confidence * 100)}%</span>
        </div>
      </div>
    </div>
  );
}
