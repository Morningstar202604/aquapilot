import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  message: string;
  /** 自动恢复尝试次数，用于避免坏帧导致无限重试 */
  retries: number;
}

/**
 * 渲染崩溃边界。
 *
 * 为什么需要：服务端可能发送不完整或异常的快照（网络截断、未来字段变更、
 * 上游 bug）。没有边界时，任意一个 undefined.toFixed() 都会让整个界面白屏，
 * 用户既看不到错误也做不了操作。这里退化成可读的故障页 + 重试入口。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, message: '', retries: 0 };

  /**
   * 自动恢复：坏帧导致崩溃后，给一次机会用后续正常数据重建。
   *
   * 为什么需要：之前边界一旦触发就永久闩锁——服务端随后发来完全正常的
   * 快照，界面仍停在错误页，只能手动刷新；若坏帧持续存在，刷新会变成循环。
   * 这里限制自动恢复次数，超过则保持在错误页并提示。
   */
  private autoRecoverTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('UI render error:', error, info.componentStack);

    if (this.state.retries >= 3) return;
    if (this.autoRecoverTimer) clearTimeout(this.autoRecoverTimer);
    this.autoRecoverTimer = setTimeout(() => {
      this.setState((prev) => ({ hasError: false, message: '', retries: prev.retries + 1 }));
    }, 3000);
  }

  override componentWillUnmount(): void {
    if (this.autoRecoverTimer) clearTimeout(this.autoRecoverTimer);
  }

  private retry = (): void => {
    // 软重试：不刷新页面，直接重新渲染，保留已收到的数据
    this.setState((prev) => ({ hasError: false, message: '', retries: prev.retries + 1 }));
  };

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        style={{
          display: 'grid',
          placeItems: 'center',
          height: '100%',
          padding: 24,
          background: '#06100f',
          color: '#e4f2ee',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ maxWidth: 520 }}>
          <div style={{ fontSize: 13, letterSpacing: '0.1em', color: '#ff6b5a', marginBottom: 10 }}>
            界面渲染失败
          </div>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: '#9db8b2', margin: '0 0 16px' }}>
            仿真服务可能返回了不完整的数据，或页面状态已损坏。重新加载通常可以恢复；若持续出现，请检查服务端日志。
          </p>
          <pre
            style={{
              fontSize: 11,
              background: '#0d211f',
              border: '1px solid #1d3b37',
              padding: 10,
              overflowX: 'auto',
              color: '#9db8b2',
              margin: '0 0 16px',
            }}
          >
            {this.state.message}
          </pre>
          <button
            onClick={this.retry}
            style={{
              height: 32,
              padding: '0 14px',
              background: 'rgba(62,224,181,0.12)',
              border: '1px solid #1c7f68',
              color: '#3ee0b5',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            重试渲染
          </button>
          {this.state.retries > 0 && (
            <p style={{ fontSize: 11, color: '#5f7d78', margin: '12px 0 0' }}>
              已自动恢复 {this.state.retries} 次。若持续失败，说明数据协议与服务端不一致。
            </p>
          )}
        </div>
      </div>
    );
  }
}
