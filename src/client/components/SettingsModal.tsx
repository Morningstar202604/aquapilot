interface Props {
  /** dialog 的无障碍名称，同时用于关闭按钮的 aria-label。 */
  label: string;
  title: string;
  subtitle: string | null;
  onClose: () => void;
  children?: React.ReactNode;
  cardClassName?: string;
}

/**
 * 设置类弹层的共用外壳：遮罩、卡片、标题栏、关闭按钮。
 *
 * Agent 设置与模型设置此前各写一遍同一套 `.model-modal` / `.model-head`，
 * 连“正在读取配置…”的空态都重复。这里只抽外壳，表单内容仍各自拥有。
 */
export function SettingsModal({ label, title, subtitle, onClose, children, cardClassName }: Props) {
  return (
    <div className="model-modal" role="dialog" aria-modal="true" aria-label={label}>
      <div className={cardClassName ? `model-card ${cardClassName}` : 'model-card'}>
        <div className="model-head">
          <div>
            <div className="model-title">{title}</div>
            {subtitle !== null && <div className="model-sub">{subtitle}</div>}
          </div>
          <button className="model-close" onClick={onClose} aria-label={`关闭 ${label}`}>
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
