import { useEffect, useState, type ReactNode } from 'react';

/**
 * 访问令牌入口。
 *
 * 只有当服务端开启访问控制（AQUAPILOT_TOKEN）时才出现。
 * 令牌存 sessionStorage，不落 localStorage：关闭标签页即失效，减少泄露面。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'open' | 'locked'>('checking');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/auth-required');
        const json = (await res.json()) as { required: boolean };
        if (cancelled) return;
        if (!json.required) {
          setState('open');
          return;
        }
        const stored = window.sessionStorage.getItem('aquapilot_token');
        setState(stored ? 'open' : 'locked');
      } catch {
        if (!cancelled) setState('open');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = (): void => {
    const value = draft.trim();
    if (!value) {
      setError('请输入访问令牌');
      return;
    }
    try {
      window.sessionStorage.setItem('aquapilot_token', value);
    } catch {
      setError('浏览器不允许写入存储');
      return;
    }
    // 用 /api/snapshot 验证令牌是否正确
    void (async () => {
      try {
        const res = await fetch('/api/snapshot', { headers: { Authorization: `Bearer ${value}` } });
        if (res.ok) {
          setState('open');
          window.location.reload();
        } else {
          window.sessionStorage.removeItem('aquapilot_token');
          setError('令牌无效');
        }
      } catch {
        setError('无法连接服务');
      }
    })();
  };

  if (state === 'checking') return <div className="loading">检查访问权限…</div>;
  if (state === 'open') return <>{children}</>;

  return (
    <div className="auth-gate">
      <div className="auth-card">
        <div className="auth-brand">AQUAPILOT</div>
        <p className="auth-hint">该仿真服务已启用访问控制，请输入运维提供的访问令牌。</p>
        <input
          type="password"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="访问令牌"
          aria-label="访问令牌"
          autoComplete="off"
        />
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
        <button className="auth-submit" onClick={submit}>
          进入
        </button>
      </div>
    </div>
  );
}
