# AquaPilot Work Log

## Current milestone

- [x] M0 Rust workspace, ASM2d CSTR + 5-pool network parity
- [x] M1 ASM1 reaction surface (13 components, 8 processes, 20/15 C parity)
- [ ] M1 ASM1 CSTR / network integration
- [ ] M1 Takács settler parity
- [ ] M1 ADM1 parity
- [ ] M1 hydraulics / transport parity
- [ ] WP2 30 d COD/N/P balance closure
- [ ] M2 Rust server / AI / CLI
- [ ] M3 frontend / industrial acceptance
- [ ] M4 optional zero-TypeScript migration

## Latest verifiable state

- `cargo test`: 8 unit + ASM1 parity 2 + CSTR parity 1 + network parity 1, all pass
- `cargo clippy --all-targets -- -D warnings`: clean
- `npx vitest run`: 1618 passed / 1619; one WP2 30 d balance failure
- `npm run e2e`: pass (17 nodes, 3 charts, 6 panels, 6 topbar widths, 0 console errors)
- Latest commits: `26e8ccc`, `22b405c`, `b988495`, `f811c36`

## Rule

Every turn must land a code/test/golden commit or explicitly record a blocker;
do not repeat the same probe without a code change.

## 2026-11-24 repository delivery

- [x] Concise English/Chinese README, screenshots and demo linked
- [x] Five-platform main synced; all side branches removed
- [x] GitHub descriptions, topics, auto-merge, delete-branch-on-merge and main protection enabled
- [x] Gitee/GitCode descriptions, main branch and merge settings set
- [x] Docs consistency tests repaired
- [ ] WP2 30 d COD/N/P balance closure (remaining red CI gate)

## 2026-11-24 前端收尾（已做完）

- [x] 工艺编排默认 1:1，不再在桌面被强制压到 64% 小字
- [x] 全览随容器尺寸重算，1024/1280 不再沿用旧缩放裁掉右侧单元
- [x] 1100px 以下编辑器改单列可滚动：组件库横条、画布固定可用高度、属性栏可到达
- [x] 画布解除监视视图的 30dvh 高度上限，三条泳道在窄屏完整可见
- [x] 编辑态节点间距 46px、泳道分隔线加深、图例移到画布上方工具带、端口热区扩到 21px
- [x] 触屏单指平移画布，1:1 下可拖到右侧与下方单元
- [x] 前端相关 87 项单测通过；全量 1618/1619，唯一红灯仍是 WP2 全厂 COD/N/P 边界
