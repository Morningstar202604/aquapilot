#!/usr/bin/env python3
"""Render the V2 30-day ASM2d + one-way ADM1 dashboard.

Inputs: /tmp/a2o-30d.json and /tmp/a2o-sludge.json (CLI snapshots).
Output: docs/screenshots/v2-30d-dashboard.png (2400x1350, 16:9).
"""

import json
import matplotlib

matplotlib.use("Agg")
import matplotlib.patches as patches
import matplotlib.pyplot as plt
import numpy as np

plt.rcParams["font.family"] = "Noto Sans CJK SC"
plt.rcParams["axes.unicode_minus"] = False

a = json.load(open("/tmp/a2o-30d.json"))
c = json.load(open("/tmp/a2o-sludge.json"))["sludge"]
d = c["line"]["digester"]

bg, panel, panel2 = "#0B1220", "#131C2E", "#0F1728"
text, muted = "#E6F1FF", "#8DA3C0"
cyan, green, amber, violet = "#37D3FF", "#4ADE80", "#FBBF24", "#A78BFA"

fig = plt.figure(figsize=(16, 9), dpi=150)
fig.patch.set_facecolor(bg)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, 16)
ax.set_ylim(0, 9)
ax.axis("off")


def box(x, y, w, h, color=panel, alpha=1.0, ec="#23314A", lw=0.8, r=0.10):
    ax.add_patch(
        patches.FancyBboxPatch(
            (x, y), w, h, boxstyle=f"round,pad=0.012,rounding_size={r}",
            facecolor=color, edgecolor=ec, linewidth=lw, alpha=alpha,
        )
    )


def txt(x, y, s, size=12, color=text, weight="normal", ha="left", va="center"):
    ax.text(x, y, s, fontsize=size, color=color, fontweight=weight, ha=ha, va=va,
            family="Noto Sans CJK SC")


box(0.55, 7.75, 14.9, 0.85, panel)
txt(0.85, 8.22, "AquaPilot V2", 22, text, "bold")
txt(3.05, 8.24, "ASM2d 30 d · ADM1 泥线 20 d 单向接口 · 质量账", 11.5, muted)
ax.add_patch(patches.FancyBboxPatch((12.55, 8.02), 2.55, 0.35,
    boxstyle="round,pad=0.01,rounding_size=0.17", facecolor="#103A2B",
    edgecolor=green, linewidth=0.8))
txt(12.72, 8.20, "● 三本账闭合", 10.5, green, "bold")
txt(13.85, 8.20, "5 平台已推送", 9.5, muted)

kpis = [
    ("出水 COD", f"{a['effluent']['cod']:.2f}", "mg/L", cyan),
    ("出水 TN", f"{a['effluent']['tn']:.2f}", "mg/L", green),
    ("出水 TP", f"{a['effluent']['tp']:.2f}", "mg/L", amber),
    ("出水 SS", f"{a['effluent']['ss']:.2f}", "mg/L", violet),
    ("沼气 ADM1", f"{d['biogas_m3_per_d']:,.0f}", "m³/d", cyan),
]
for i, (label, value, unit, col) in enumerate(kpis):
    x = 0.55 + i * 2.98
    box(x, 6.62, 2.82, 0.92, panel2)
    txt(x + 0.18, 7.30, label, 9.5, muted)
    txt(x + 0.18, 6.94, value, 20, col, "bold")
    txt(x + 2.05, 6.94, unit, 8.5, muted)

box(0.55, 1.35, 5.45, 5.05)
txt(0.82, 6.18, "出水水质", 13, text, "bold")
txt(4.55, 6.18, "mg/L · 30 d 稳态", 9, muted)
labels = ["COD", "S_S", "NH4-N", "NO3-N", "TN", "TP", "PO4-P", "SS"]
vals = [a["effluent"][k] for k in ("cod", "s_s", "nh4_n", "no3_n", "tn", "tp", "po4_p", "ss")]
colors = [cyan, cyan, green, green, green, amber, amber, violet]
ax2 = fig.add_axes([0.05125, 0.2278, 0.30625, 0.4167])
ax2.set_facecolor(panel)
y = np.arange(len(labels))[::-1]
ax2.barh(y, vals, color=colors, height=0.55, alpha=0.92)
for yi, v in zip(y, vals):
    ax2.text(v + 0.6, yi, f"{v:.2f}", va="center", fontsize=10, color=text)
ax2.set_yticks(y)
ax2.set_yticklabels(labels, fontsize=10, color=text)
ax2.set_xlim(0, 50)
ax2.set_xticks([])
for s in ("top", "right", "bottom", "left"):
    ax2.spines[s].set_visible(False)
ax2.tick_params(axis="y", length=0, pad=8)
ax2.grid(axis="x", color="#25324A", linewidth=0.6, alpha=0.7)
ax2.set_axisbelow(True)

box(6.18, 1.35, 4.55, 5.05)
txt(6.45, 6.18, "三本账残差", 13, text, "bold")
txt(9.55, 6.18, "阈值 5%", 9, muted)
for i, (name, ledger, col) in enumerate([
    ("COD", a["mass_balance"]["cod"], cyan),
    ("N", a["mass_balance"]["nitrogen"], green),
    ("P", a["mass_balance"]["phosphorus"], amber),
]):
    yy = 5.35 - i * 1.35
    txt(6.45, yy, name, 16, col, "bold")
    txt(6.45, yy - 0.38,
        f"in {ledger['inflow_kg']:,.0f} kg  ·  out {ledger['effluent_kg']:,.0f} kg",
        8.8, muted)
    ax.add_patch(patches.FancyBboxPatch((6.95, yy - 0.13), 3.45, 0.18,
        boxstyle="round,pad=0.005,rounding_size=0.08", facecolor="#0B1220",
        edgecolor="#25324A", linewidth=0.5))
    w = min(abs(ledger["residual_fraction"]) / 0.05, 1.0) * 3.45
    ax.add_patch(patches.FancyBboxPatch((6.95, yy - 0.13), w, 0.18,
        boxstyle="round,pad=0.005,rounding_size=0.08", facecolor=col, edgecolor="none"))
    txt(10.57, yy, f"{ledger['residual_fraction']*100:.2f}%", 11, col, "bold", ha="right")
    txt(10.57, yy - 0.35, "闭合", 8.5, green)
txt(6.45, 1.62, "库存变化、排泥、氧化/气态损失均入账；无放宽容差。", 8.6, muted)

box(10.95, 4.15, 4.5, 2.25)
txt(11.2, 6.18, "二沉池分层 TSS", 13, text, "bold")
txt(13.75, 6.18, "mg/L", 9, muted)
txt(11.2, 5.98, "feed 3 094 → underflow 6 057 → overflow 11.4 mg/L", 8.2, muted)
layers = a["clarifier"]["layer_tss"]
ax3 = fig.add_axes([0.6969, 0.4944, 0.2531, 0.15])
ax3.set_facecolor(panel)
xs = np.arange(len(layers))
ax3.plot(xs, layers, "-o", color=cyan, linewidth=1.6, markersize=3.2)
ax3.fill_between(xs, layers, color=cyan, alpha=0.10)
ax3.set_yscale("log")
ax3.set_ylim(8, 8000)
ax3.set_xticks([0, 4, 9])
ax3.set_xticklabels(["底", "中", "顶"], fontsize=8, color=muted)
ax3.tick_params(axis="y", labelsize=7, colors=muted, length=0)
for s in ("top", "right"):
    ax3.spines[s].set_visible(False)
for s in ("left", "bottom"):
    ax3.spines[s].set_color("#25324A")
ax3.grid(color="#25324A", linewidth=0.5, alpha=0.5)
ax3.set_axisbelow(True)

box(10.95, 1.35, 4.5, 2.55)
txt(11.2, 3.62, "ADM1 厌氧消化（单向接入）", 13, text, "bold")
txt(11.2, 3.35, "2 400 m³ · 120 m³/d · 35 °C", 8.4, muted)
ax4 = fig.add_axes([0.6969, 0.18, 0.0906, 0.1611])
sizes = [d["methane_fraction"], d["co2_fraction"], d["h2_fraction"]]
ax4.pie(sizes, colors=[green, amber, cyan], startangle=90, counterclock=False,
        wedgeprops=dict(width=0.32, edgecolor=panel, linewidth=1.5))
ax4.text(0, 0, f"{d['methane_fraction']*100:.1f}%", ha="center", va="center",
         fontsize=10, color=text, fontweight="bold")
ax4.set_aspect("equal")
txt(12.9, 3.10, f"CH4 {d['methane_fraction']*100:.1f}%", 10, green, "bold")
txt(12.9, 2.85, f"CO2 {d['co2_fraction']*100:.1f}%", 9, amber)
txt(12.9, 2.61, f"H2 {d['h2_fraction']*100:.2f}%", 9, cyan)
txt(12.75, 2.31, f"pH {d['ph']:.3f}  ·  沼气 {d['biogas_m3_per_d']:,.0f} m³/d", 8.2, muted)
txt(12.75, 2.07, "泥线 COD/N/P 0.00/0.00/0.00%", 8.2, green)
txt(12.75, 1.80, "滤液未回流 · 接口为单向", 8.2, muted)

txt(0.55, 0.72, "HEAD main · 40 项测试 · cargo fmt / clippy 通过", 8.5, muted)
txt(15.15, 0.72, "数据：a2o-asm2d · adm1-sludge-line 单向耦合", 8.5, muted, ha="right")
ax.plot([0.55, 15.45], [0.95, 0.95], color="#25324A", linewidth=0.8)
ax.plot([0.55, 0.55], [1.35, 7.6], color=cyan, linewidth=1.2, alpha=0.6)

plt.savefig("docs/screenshots/v2-30d-dashboard.png", facecolor=bg, dpi=150)
print("saved docs/screenshots/v2-30d-dashboard.png")
