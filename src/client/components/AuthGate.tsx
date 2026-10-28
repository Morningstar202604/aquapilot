import { useEffect, useState, type ReactNode } from 'react';

/**
 * 访问令牌入口。
 *
 * 只有当服务端开启访问控制（AQUAPILOT_TOKEN）时才出现。
 * 令牌存 sessionStorage，不落 localStorage：关闭标签页即失效，减少泄露面。
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'open' | 'locked' | 'unreachable'>('checking');
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
        if (!stored) {
          setState('locked');
          return;
        }
        /**
         * 存储里的令牌必须真的能通过一次 API 校验才放行。
         *
         * 早先只看"有没有存过"：令牌过期或服务端轮换后，页面照常打开，
         * 但 WebSocket 在握手阶段被拒，界面永远停在"断线重连"，
         * 用户既看不到错误也没有重新输入入口。
         */
        const probe = await fetch('/api/snapshot', { headers: { Authorization: `Bearer ${stored}` } });
        if (cancelled) return;
        if (probe.ok) {
          setState('open');
        } else {
          window.sessionStorage.removeItem('aquapilot_token');
          setError('保存的令牌已失效，请重新输入');
          setState('locked');
        }
      } catch {
        /**
         * 探测失败不能 fail-open。
         *
         * 旧实现在这里直接进应用：如果服务端其实启用了令牌（只是这次探测
         * 网络抖动/代理超时），WebSocket 会一直被拒，界面停在「断线重连」，
         * 而且再也拿不到令牌输入框。失败必须显示可重试的提示。
         */
        if (!cancelled) {
          setError('无法确认访问策略（服务不可达），请检查服务后重试');
          setState('unreachable');
        }
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
  if (state === 'unreachable') {
    return (
      <div className="auth-gate">
        <div className="auth-card">
          <div className="auth-brand">AQUAPILOT</div>
          <p className="auth-hint">{error ?? '无法连接仿真服务。'}</p>
          <button
            className="auth-submit"
            onClick={() => {
              setError(null);
              setState('checking');
              window.location.reload();
            }}
          >
            重试
          </button>
        </div>
      </div>
    );
  }

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
