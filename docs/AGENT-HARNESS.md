# Agent Harness 生态：调研与落地（2026-03）

> **调研结论的落地状态**：P0（MCP Streamable HTTP 端点）已于 v0.6.0 实现——
> `POST /mcp`，协议版本 2025-06-18，10 个工具（读写分离），分级令牌鉴权 +
> 限流 + Origin 校验，见 `src/server/mcp.ts` 与 `tests/mcpServer.test.ts`。
> 外部 agent 框架（LangGraph / OpenAI Agents SDK / CrewAI / Vercel AI SDK /
> Mastra）配置 Streamable HTTP URL 即可直连。P1/P2 项见文末优先级清单。

## 1. 协议层

| 协议 | 定位 | 与"仿真器暴露给外部 AI agent"匹配度 |
|---|---|---|
| **MCP** | Agent↔工具/数据的事实标准（JSON-RPC 2.0，stdio / Streamable HTTP），2025-11-25 为最新修订，已捐入 Linux Foundation AAIF（2025-12-09），月 SDK 下载 97M+ | **最高**。AquaPilot 的仿真器正属于"工具/数据源"层，MCP 即为此设计 |
| **A2A** | Agent↔Agent 委托协作（Google 2025-04 发布，同年 6 月入 Linux Foundation，spec v1.0 于 2026-03），以 Agent Card 发现、Task 生命周期为核心 | 低。AquaPilot 不是自主 agent，无需被其他 agent 委托任务 |
| **ACP** | IBM/BeeAI 的 REST-first Agent↔Agent 协议，2025-08 已并入 A2A 并归档 | 已失效，仅作历史参考 |
| **AG-UI** | CopilotKit 的 Agent↔前端事件流协议（SSE/WS），标准化消息、工具调用、状态更新推送 | 可选。AquaPilot 已有自研 WS 事件流，功能上即是 AG-UI 的非标版本 |

来源：https://veso.ai/research/agentic-patterns/tool-protocols ；https://www.xicom.biz/blog/ai-agent-protocols ；https://mdpi.com/1999-5903/18/3/171 ；https://wpnews.pro/news/mcp-vs-a2a-vs-acp-open-protocols-for-multi-agent-systems-compared

## 2. 框架生态：全部经 MCP 消费外部工具

- **LangChain/LangGraph**：`langchain-mcp-adapters` 的 `MultiServerMCPClient`，`transport: "streamable_http"` 直连 URL 即注入工具。
- **OpenAI Agents SDK**：`MCPServerStreamableHttp` / 托管 `HostedMCPTool`，SDK 自动调 `list_tools()`。
- **CrewAI**：`crewai-tools` 的 `MCPServerAdapter({"url": ..., "transport": "streamable-http"})`。
- **Vercel AI SDK**（v6，2025-12 GA）：`experimental_createMCPClient` + `StreamableHTTPClientTransport`；注意它是轻量客户端，不含会话管理与断流恢复。
- **Mastra**：TS 框架，基于 Vercel AI SDK，内置 MCP 客户端与 Zod 校验。
- 结论：**MCP 已是唯一事实标准**，"会讲 MCP"是框架默认能力；一个 Streamable HTTP URL 即可被上述所有框架消费。

来源：https://help.keboola.com/ai/mcp-server ；https://github.com/sera-cx/sera-agents/blob/main/integrations/frameworks.md ；https://www.open-source-ai.tech/projects/vercel-ai-sdk ；https://dev.to/hani__8725b7a/agentic-ai-frameworks-comparison-2025-mcp-agent-langgraph-ag2-pydanticai-crewai-h40

## 3. 参考实现的工具设计模式

- 官方 servers 仓库 2025-05 精简后保留 Filesystem/Git/Fetch/Memory/Sequential Thinking/Time/**Everything**；sqlite 移入 servers-archived。
- **sqlite server 六工具模式**（粒度范本）：`read_query` / `write_query` / `create_table` / `list_tables` / `describe_table` / `append_insight`——读写分离、schema 内省与数据操作分开、少量粗粒度工具，符合"schema 内省 → 构造调用"的 agent 推理链。
- **everything server**：演示性 server，单进程同时服务 stdio + Streamable HTTP（`/mcp` 端点），验证 Origin（仅 localhost 放行，其余 403），示范 annotations（readOnlyHint）、结构化输出、资源链接等全量特性。
- **错误约定勘误**：规范中**不存在 `outputError` 字段**。实际约定是两类错误：(a) 协议错误 → JSON-RPC error，未知工具/参数非法用 `-32602`；(b) 工具执行错误 → 正常 result 中 `isError: true` + 文本 content，供模型自纠错重试。SDK v2 线上行为确认：未知工具返回 -32602，tool schema 声明 JSON Schema 2020-12。

来源：https://github.com/modelcontextprotocol/servers/tree/main/src/everything ；https://deepwiki.com/modelcontextprotocol/servers-archived/3.2-database-servers ；https://hub.docker.com/mcp/server/SQLite ；https://modelcontextprotocol.io/docs/concepts/tools ；https://modelcontextprotocol.io/specification/2025-06-18/server/tools

## 4. 结论：AquaPilot 缺什么（优先级）

1. **P0 — MCP Streamable HTTP server 端点**：当前外部 agent 只能走 webhook/内部 API，无法被任何框架直连。实现 `POST /mcp` 后即进入全框架生态（见第 5 节最小实现）。
2. **P1 — 工具面重塑为 MCP 风格**：仿 sqlite 六工具模式，将仿真器封装为 `list_scenarios`（内省）/ `get_state` / `step` / `set_influent`（写）/ `reset`（破坏性）/ `get_metrics`，读写分离、inputSchema 完整、执行错误用 `isError: true` 返回业务信息（如曝气量超限）。
3. **P1 — structuredContent/outputSchema**：仿真状态查询返回 `structuredContent` + 同步 text 副本，让外部 agent 无需解析散文。
4. **P2 — 安全对齐**：MCP 端点复用现有 SSRF 防护经验；验证 Origin、校验全部工具输入、限流、输出脱敏（规范 MUST 项）。
5. **P3 — AG-UI 类事件流标准化**：现有 WS 事件流可保持，暂不必实现 AG-UI。
6. **不建议**：A2A/ACP（定位不符）。

## 5. 最小 MCP Streamable HTTP 实现（保守方案，无 SSE 可用）

规范要点（2025-06-18 / 2025-11-25 修订）：
- 单一 MCP 端点（如 `POST /mcp`），**必须同时支持 GET**——无 SSE 时 GET 直接返回 `405 Method Not Allowed` 即合规。
- 每条 JSON-RPC 消息独立 POST；请求须带 `Accept: application/json, text/event-stream`；服务器对 request 以 `Content-Type: application/json` 返回单个 JSON 对象即合法（SSE 是 MAY）。
- 对 notification/response 返回 `202 Accepted`（无 body）。
- **握手头**：
  - `initialize` 响应可（MAY）携带 `Mcp-Session-Id` 头分配会话；一旦下发，客户端后续请求必须回传，缺头的服务器应回 400；客户端 DELETE 该头可终止会话（可回 405 拒绝）。无状态实现可不发此头。
  - 客户端后续所有请求**必须**带 `MCP-Protocol-Version: 2025-06-18`（初始化协商值）；未带时服务器应假定 `2025-03-26`；收到无效版本必须回 400。
- 安全 MUST：校验 `Origin` 头（防 DNS rebinding）、输入校验、限流。
- 必须实现的方法：`initialize` → `notifications/initialized`（回 202）→ `tools/list` → `tools/call`；建议声明 `tools: { listChanged: false }` capability；回 2026-07-28 新版规范的成本更高，先锚定 2025-06-18。

来源：https://modelcontextprotocol.io/specification/2025-06-18/basic/transports ；https://modelcontextprotocol.io/specification/2025-06-18/changelog ；https://modelcontextprotocol.io/specification/2025-06-18/server/tools
