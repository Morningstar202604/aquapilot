import { PALETTE, PALETTE_GROUPS, type PaletteEntry } from '../../model/editorPalette';
import { unitKindAccent } from '../../shared/streamMeta';

/** 拓扑编辑器左侧组件库；分组和条目都来自 model/editorPalette */
export function EditorPalette({ onAdd }: { onAdd: (entry: PaletteEntry) => void }) {
  return (
    <div className="editor-palette">
      {PALETTE_GROUPS.map((group) => (
        <div key={group}>
          <div className="palette-group-title">{group}</div>
          {PALETTE.filter((p) => p.group === group).map((entry) => (
            <button
              className="palette-item"
              key={entry.kind + entry.name}
              onClick={() => onAdd(entry)}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-aquapilot-unit', entry.kind);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              title="点击添加，或拖到画布上放置"
            >
              <span className="palette-glyph" style={{ borderColor: unitKindAccent(entry.kind) }} />
              <span className="palette-name">{entry.name}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
