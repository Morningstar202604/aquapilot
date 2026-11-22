import type { AlignMode } from '../hooks/editorSelection';

export interface IoNote {
  kind: 'ok' | 'error';
  text: string;
}

interface Props {
  dirty: boolean;
  units: number;
  connections: number;
  errorCount: number;
  ioNote: IoNote | null;
  onDismissIo: () => void;
  selectionCount: number;
  hasSelected: boolean;
  connectLabel: string | null;
  onCancelConnect: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onRestore: () => void;
  onExport: () => void;
  onImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
  layoutDirty: boolean;
  onResetLayout: () => void;
  ready: boolean;
  onApply: () => void;
  onDeleteSelection: () => void;
  onAlign: (mode: AlignMode) => void;
  onDistribute: (axis: 'x' | 'y') => void;
  onClearMulti: () => void;
}

/** 编辑器顶部工具栏：状态、撤销、导入导出、应用与对齐 */
export function EditorToolbar({
  dirty,
  units,
  connections,
  errorCount,
  ioNote,
  onDismissIo,
  selectionCount,
  hasSelected,
  connectLabel,
  onCancelConnect,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onRestore,
  onExport,
  onImport,
  layoutDirty,
  onResetLayout,
  ready,
  onApply,
  onDeleteSelection,
  onAlign,
  onDistribute,
  onClearMulti,
}: Props) {
  return (
    <div className="editor-toolbar">
      <span className="pill" data-tone={dirty ? 'amber' : undefined}>
        <span className="dot" data-tone={dirty ? 'amber' : undefined} />
        {dirty ? '草稿未应用' : '与运行中一致'}
      </span>
      <span className="pill">
        {units} 单元 · {connections} 物流
      </span>
      <span className="pill">{errorCount} 错误</span>
      {ioNote && (
        <span className="pill pill-io" data-tone={ioNote.kind === 'error' ? 'alarm' : undefined} role="status">
          {ioNote.text}
          <button className="pill-io-close" aria-label="关闭提示" onClick={onDismissIo}>
            ×
          </button>
        </span>
      )}
      {selectionCount > 1 && (
        <span className="pill" data-tone="amber" data-active>
          已选 {selectionCount} 个
        </span>
      )}
      <span className="toolbar-spacer" />
      {connectLabel && (
        <span className="pill" data-tone="amber">
          从 {connectLabel} 连线中 · 点目标端口
          <button style={{ marginLeft: 6, color: 'inherit' }} onClick={onCancelConnect}>
            取消
          </button>
        </span>
      )}

      <button className="pill" onClick={onUndo} disabled={!canUndo} title="撤销上一步编辑（Ctrl/Cmd+Z）">
        ↶ 撤销
      </button>
      <button className="pill" onClick={onRedo} disabled={!canRedo} title="重做（Ctrl/Cmd+Shift+Z）">
        ↷ 重做
      </button>
      <button className="pill" onClick={onRestore}>
        恢复标准厂
      </button>
      <button className="pill" onClick={onExport} title="导出为 JSON 文件，可存档或分享给同事">
        导出
      </button>
      <label className="pill pill-file" title="导入 JSON 拓扑（覆盖当前草稿，可撤销）">
        导入
        <input type="file" accept="application/json,.json" onChange={onImport} aria-label="导入拓扑文件" />
      </label>
      {layoutDirty && (
        <button className="pill" title="把手工摆放的坐标与折点清空，回到自动分层布局与自动走线" onClick={onResetLayout}>
          自动排列
        </button>
      )}
      <button className="pill" data-active={ready} onClick={onApply} disabled={!ready}>
        应用到仿真
      </button>
      <button
        className="pill"
        title="删除选中的全部单元（可撤销）"
        aria-label="批量删除"
        disabled={selectionCount === 0 && !hasSelected}
        onClick={onDeleteSelection}
      >
        删除选中
      </button>
      {selectionCount >= 2 && (
        <span className="editor-align-group" role="group" aria-label="对齐">
          <button className="pill" title="左对齐" aria-label="左对齐" onClick={() => onAlign('left')}>
            左对齐
          </button>
          <button className="pill" title="顶部对齐" aria-label="顶部对齐" onClick={() => onAlign('top')}>
            顶对齐
          </button>
          <button className="pill" title="右对齐" aria-label="右对齐" onClick={() => onAlign('right')}>
            右对齐
          </button>
          <button className="pill" title="底部对齐" aria-label="底部对齐" onClick={() => onAlign('bottom')}>
            底对齐
          </button>
          {selectionCount >= 3 && (
            <>
              <button className="pill" title="水平等距" aria-label="水平等距" onClick={() => onDistribute('x')}>
                横等距
              </button>
              <button className="pill" title="垂直等距" aria-label="垂直等距" onClick={() => onDistribute('y')}>
                竖等距
              </button>
            </>
          )}
          <button className="pill" title="取消多选（Esc）" aria-label="取消多选" onClick={onClearMulti}>
            取消
          </button>
        </span>
      )}
    </div>
  );
}
