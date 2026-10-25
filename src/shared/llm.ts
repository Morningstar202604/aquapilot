/**
 * 自定义模型配置的共享类型与纯函数。
 *
 * 浏览器和服务端都要用同一套协议枚举、能力默认值和预置地址，
 * 放在 shared 里避免两边各写一份而漂移。
 */

export type LlmProtocol = 'openai' | 'anthropic' | 'google';

export interface ModelCapabilities {
  contextWindow: number;
  maxOutput: number;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
}

export interface DiscoveredModel {
  id: string;
  label: string;
  ownedBy?: string;
  contextWindow?: number;
  maxOutput?: number;
}

export interface LlmDraft {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  capabilities: ModelCapabilities;
  autoCapabilities: boolean;
}

export interface LlmPublicConfig {
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  capabilities: ModelCapabilities;
  autoCapabilities: boolean;
  hasKey: boolean;
  apiKeyMasked: string;
  updatedAt: string;
}

export interface LlmDiscoverInput {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey?: string;
}

export interface LlmTestInput extends LlmDiscoverInput {
  model: string;
  maxOutput?: number;
}

export interface LlmTestResult {
  ok: boolean;
  latencyMs: number;
  reply?: string;
  error?: string;
}

export const PROTOCOLS: LlmProtocol[] = ['openai', 'anthropic', 'google'];

export const PROTOCOL_META: Record<LlmProtocol, { label: string; hint: string }> = {
  openai: { label: 'OpenAI 兼容', hint: '/chat/completions + /models，覆盖 DeepSeek、GLM、Qwen、Kimi、vLLM 等' },
  anthropic: { label: 'Anthropic Messages', hint: '/v1/messages + /v1/models' },
  google: { label: 'Google Gemini', hint: '/v1beta/models + generateContent' },
};

export interface BaseUrlPreset {
  protocol: LlmProtocol;
  label: string;
  url: string;
}

/** 只放主流协议下的常见地址；不预置模型名，模型一律从端点实时拉取。 */
export const BASE_URL_PRESETS: BaseUrlPreset[] = [
  { protocol: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1' },
  { protocol: 'openai', label: 'DeepSeek', url: 'https://api.deepseek.com/v1' },
  { protocol: 'openai', label: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4' },
  { protocol: 'openai', label: '通义千问', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { protocol: 'openai', label: 'Kimi', url: 'https://api.moonshot.cn/v1' },
  { protocol: 'openai', label: 'UniSound MaaS', url: 'https://maas-api.unisound.com/v1' },
  { protocol: 'openai', label: 'Ollama 本地', url: 'http://127.0.0.1:11434/v1' },
  { protocol: 'anthropic', label: 'Anthropic', url: 'https://api.anthropic.com' },
  { protocol: 'google', label: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta' },
];

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  contextWindow: 131072,
  maxOutput: 8192,
  tools: true,
  vision: false,
  reasoning: false,
  streaming: true,
};

const NON_CHAT_MODEL =
  /(embedding|embed-|text-embedding|tts|whisper|rerank|moderation|dall-e|gpt-image|imagen|speech|transcribe)/i;
const VISION_MODEL = /(vision|[-_/]vl\b|vl[-_]|\b4o\b|gemini|claude|gpt-5|gpt-6|glm-4v|llava|pixtral|internvl)/i;
const REASONING_MODEL = /(^|[-_/])(o[1-9]|r1|reasoner|reasoning|thinking|u2|qwq|glm-z|deepseek-r|magistral)/i;

export function isChatModel(id: string): boolean {
  return !NON_CHAT_MODEL.test(id);
}

/**
 * 能力自动匹配。
 *
 * 端点元数据优先；缺失的字段按协议与模型命名推断。
 * 推理模型（content 为空、只有 reasoning_content）仍按工具调用可用处理。
 */
export function inferCapabilities(
  model: { id: string; contextWindow?: number; maxOutput?: number },
  _protocol: LlmProtocol,
): ModelCapabilities {
  const chat = isChatModel(model.id);
  return {
    contextWindow: model.contextWindow ?? DEFAULT_CAPABILITIES.contextWindow,
    maxOutput: model.maxOutput ?? DEFAULT_CAPABILITIES.maxOutput,
    tools: chat,
    vision: chat && VISION_MODEL.test(model.id),
    reasoning: chat && REASONING_MODEL.test(model.id),
    streaming: chat,
  };
}

export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 3)}••••${key.slice(-4)}`;
}
