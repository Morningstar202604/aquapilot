import type { IncomingMessage } from 'node:http';

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

export class InvalidJsonError extends Error {
  constructor(message = 'invalid JSON body') {
    super(message);
    this.name = 'InvalidJsonError';
  }
}

export class UnsupportedMediaTypeError extends Error {
  constructor(readonly type: string) {
    super(`unsupported media type: ${type || '(missing)'}`);
    this.name = 'UnsupportedMediaTypeError';
  }
}

/**
 * 读取 JSON 请求体。
 *
 * 限流必须发生在完整缓冲之前：先看 Content-Length，再在流式读取中累计
 * 字节数；不能等 `Buffer.concat` 完再判断——那样攻击者已经用一个大包
 * 占满内存。只接受 application/json（允许 `+json` 后缀），避免表单编码
 * 被误当成 JSON 解析导致的歧义。
 */
export async function readJsonBody(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
  // 只接受 application/json 或结构化后缀类型（application/vnd.foo+json）；
  // 不能用 startsWith，否则 application/jsonp 会被误当成 JSON。
  const mediaType = contentType.split(';')[0]?.trim() ?? '';
  const isJson = mediaType === 'application/json' || mediaType.endsWith('+json');
  if (!isJson) throw new UnsupportedMediaTypeError(contentType);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError(limit);

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > limit) throw new BodyTooLargeError(limit);
    chunks.push(buf);
  }
  if (total === 0) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string;
  try {
    text = decoder.decode(Buffer.concat(chunks));
  } catch {
    throw new InvalidJsonError('request body is not valid UTF-8');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}
