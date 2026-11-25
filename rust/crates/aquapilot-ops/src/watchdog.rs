//! Deterministic watchdog, ported from `src/server/watchdog.ts`.
//!
//! Only actionable problems are reported. The output shape is the existing
//! `WatchdogReport` contract (`at/severity/checks[]`), so a Rust server can
//! broadcast it without a client change.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Ok,
    Warn,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Persistence {
    Enabled,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfluentSource {
    pub kind: String,
    pub name: String,
    pub span_min: Option<f64>,
    pub cycles: u64,
    pub points: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInput {
    pub tick_errors: u64,
    pub tick_delta: f64,
    pub last_tick_ms: f64,
    pub simulation_minutes: f64,
    pub paused: bool,
    pub ws_active: usize,
    pub llm_calls: u64,
    pub llm_fallbacks: u64,
    pub persistence: Persistence,
    pub persistence_errors: u64,
    pub agent_warnings: u64,
    pub agent_permission: String,
    pub hook_failures: u64,
    pub llm_configured: bool,
    pub config_path: String,
    pub influent_source: Option<InfluentSource>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CheckResult {
    pub id: String,
    pub label: String,
    pub severity: Severity,
    pub detail: String,
    pub action: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WatchdogReport {
    pub at: String,
    pub severity: Severity,
    pub checks: Vec<CheckResult>,
}

fn check(id: &str, label: &str, severity: Severity, detail: String, action: &str) -> CheckResult {
    CheckResult {
        id: id.into(),
        label: label.into(),
        severity,
        detail,
        action: action.into(),
    }
}

fn ok(id: &str, label: &str, detail: String) -> CheckResult {
    check(id, label, Severity::Ok, detail, "无需处理")
}

pub fn evaluate_checks(input: &CheckInput) -> Vec<CheckResult> {
    let mut out = Vec::new();

    out.push(if input.tick_errors > 0 {
        check(
            "sim-ticks",
            "仿真步进",
            Severity::Error,
            format!("累计 {} 次步进异常", input.tick_errors),
            "查看服务端日志 sim 相关错误，必要时重置仿真",
        )
    } else {
        ok(
            "sim-ticks",
            "仿真步进",
            format!(
                "无异常，仿真已推进 {} 分钟",
                input.simulation_minutes.round()
            ),
        )
    });

    out.push(if input.paused && input.tick_delta == 0.0 {
        check(
            "sim-live",
            "时钟推进",
            Severity::Warn,
            "仿真处于暂停状态，时钟未推进".into(),
            "确认是否为人工暂停；否则点顶栏「已暂停」恢复",
        )
    } else if input.tick_delta == 0.0 {
        check(
            "sim-live",
            "时钟推进",
            Severity::Error,
            "仿真未暂停但时钟在最近一个窗口内没有推进".into(),
            "检查 tick 定时器与服务端日志，必要时重启服务",
        )
    } else {
        ok(
            "sim-live",
            "时钟推进",
            format!("时钟正常推进（{} 仿真分钟/窗口）", input.tick_delta.round()),
        )
    });

    out.push(if input.last_tick_ms > 500.0 {
        check(
            "sim-latency",
            "步进耗时",
            Severity::Warn,
            format!("最近一次步进 {:.0} ms，接近 1 s 节拍", input.last_tick_ms),
            "减少并发控制操作或降低倍速",
        )
    } else {
        ok(
            "sim-latency",
            "步进耗时",
            format!("{:.0} ms", input.last_tick_ms),
        )
    });

    let fallback_rate = if input.llm_calls > 0 {
        input.llm_fallbacks as f64 / input.llm_calls as f64
    } else {
        0.0
    };
    out.push(if !input.llm_configured {
        check(
            "llm",
            "模型链路",
            Severity::Warn,
            "尚未配置自定义模型，回答只来自规则引擎".into(),
            "顶栏「模型设置」接入一个可用模型",
        )
    } else if fallback_rate > 0.5 && input.llm_calls >= 4 {
        check(
            "llm",
            "模型链路",
            Severity::Warn,
            format!(
                "{} 次调用中 {} 次降级（{}%）",
                input.llm_calls,
                input.llm_fallbacks,
                (fallback_rate * 100.0).round()
            ),
            "打开「模型设置」点连接测试，核对密钥/地址/模型名",
        )
    } else {
        ok(
            "llm",
            "模型链路",
            format!(
                "调用 {} 次，降级 {} 次",
                input.llm_calls, input.llm_fallbacks
            ),
        )
    });

    out.push(if input.persistence == Persistence::Disabled {
        check(
            "persistence",
            "持久化",
            Severity::Warn,
            "持久化已关闭（Node 20 或 AQUAPILOT_PERSIST=0），回放不可用".into(),
            "如需要回放，请使用 Node 22+ 并确认 data/ 可写",
        )
    } else if input.persistence_errors > 0 {
        check(
            "persistence",
            "持久化",
            Severity::Warn,
            format!("写入失败 {} 次", input.persistence_errors),
            "检查 data/ 目录权限与磁盘空间",
        )
    } else {
        ok("persistence", "持久化", "正常".into())
    });

    out.push(if input.agent_warnings > 0 {
        check(
            "agent-config",
            "Agent 配置",
            Severity::Warn,
            format!(
                "{} 条归一化告警（部分字段被忽略或夹紧）",
                input.agent_warnings
            ),
            "打开「Agent 设置」查看顶部告警并修正",
        )
    } else {
        ok(
            "agent-config",
            "Agent 配置",
            format!("权限 {}，配置可读", input.agent_permission),
        )
    });

    out.push(if input.hook_failures > 0 {
        check(
            "hooks",
            "钩子",
            Severity::Warn,
            format!("{} 次执行失败", input.hook_failures),
            "检查「Agent 设置 → 钩子」的目标地址与权限",
        )
    } else {
        ok("hooks", "钩子", "无失败".into())
    });

    let config_detail = std::path::Path::new(&input.config_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("agent-config.json");
    out.push(if std::path::Path::new(&input.config_path).exists() {
        ok("agent-file", "配置文件", config_detail.to_string())
    } else {
        check(
            "agent-file",
            "配置文件",
            Severity::Ok,
            "尚未落盘（使用默认配置）".into(),
            "在「Agent 设置」里保存一次即可生成",
        )
    });

    out.push(check(
        "ws",
        "客户端连接",
        if input.ws_active > 0 {
            Severity::Ok
        } else {
            Severity::Warn
        },
        format!("{} 个连接", input.ws_active),
        if input.ws_active > 0 {
            "无需处理"
        } else {
            "确认浏览器页面是否已打开"
        },
    ));

    match &input.influent_source {
        None => out.push(ok(
            "influent-source",
            "进水数据源",
            "未采集（使用内置模型）".into(),
        )),
        Some(src) if src.kind == "synthetic" => out.push(ok(
            "influent-source",
            "进水数据源",
            "合成进水（昼夜节律 + 噪声）".into(),
        )),
        Some(src) => {
            let span_h = src.span_min.unwrap_or(0.0) / 60.0;
            let looping = src.cycles >= 1;
            out.push(if looping {
                check(
                    "influent-source",
                    "进水数据源",
                    Severity::Warn,
                    format!(
                        "CSV「{}」{} 点 / {:.1} h，已循环 {} 轮——后续工况是同一段历史的重复",
                        src.name, src.points, span_h, src.cycles
                    ),
                    "接入持续采集，或换用覆盖更长周期的进水序列",
                )
            } else {
                ok(
                    "influent-source",
                    "进水数据源",
                    format!(
                        "CSV「{}」{} 点 / {:.1} h，仍在有效期内",
                        src.name, src.points, span_h
                    ),
                )
            });
        }
    }

    out
}

pub fn overall_severity(checks: &[CheckResult]) -> Severity {
    if checks.iter().any(|c| c.severity == Severity::Error) {
        Severity::Error
    } else if checks.iter().any(|c| c.severity == Severity::Warn) {
        Severity::Warn
    } else {
        Severity::Ok
    }
}

pub fn build_report(input: &CheckInput, at: &str) -> WatchdogReport {
    let checks = evaluate_checks(input);
    let severity = overall_severity(&checks);
    WatchdogReport {
        at: at.into(),
        severity,
        checks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn healthy() -> CheckInput {
        CheckInput {
            tick_errors: 0,
            tick_delta: 2.0,
            last_tick_ms: 12.0,
            simulation_minutes: 42.0,
            paused: false,
            ws_active: 1,
            llm_calls: 10,
            llm_fallbacks: 1,
            persistence: Persistence::Enabled,
            persistence_errors: 0,
            agent_warnings: 0,
            agent_permission: "admin".into(),
            hook_failures: 0,
            llm_configured: true,
            config_path: "/nonexistent/agent-config.json".into(),
            influent_source: None,
        }
    }

    #[test]
    fn healthy_plant_is_all_ok() {
        let report = build_report(&healthy(), "2026-11-25T12:00:00Z");
        assert_eq!(report.severity, Severity::Ok);
        assert_eq!(report.checks.len(), 10);
        assert!(report.checks.iter().all(|c| c.severity == Severity::Ok));
    }

    #[test]
    fn stalled_clock_is_error_and_pause_is_warn() {
        let mut input = healthy();
        input.tick_delta = 0.0;
        assert_eq!(overall_severity(&evaluate_checks(&input)), Severity::Error);
        input.paused = true;
        assert_eq!(overall_severity(&evaluate_checks(&input)), Severity::Warn);
    }

    #[test]
    fn looping_csv_is_explicitly_warned() {
        let mut input = healthy();
        input.influent_source = Some(InfluentSource {
            kind: "csv".into(),
            name: "influent.csv".into(),
            span_min: Some(720.0),
            cycles: 2,
            points: 720,
        });
        let report = build_report(&input, "2026-11-25T12:00:00Z");
        assert_eq!(report.severity, Severity::Warn);
        let source = report
            .checks
            .iter()
            .find(|c| c.id == "influent-source")
            .unwrap();
        assert!(source.detail.contains("已循环 2 轮"));
    }
}
