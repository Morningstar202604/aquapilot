/**
 * WebSocket 令牌子协议编解码。
 *
 * 浏览器无法为 WebSocket 握手设置 Authorization 头，业界做法是把令牌
 * 放进 `Sec-WebSocket-Protocol`。但该头的值受 RFC 7230 token 语法约束：
 * 只能是 `!#$%&'*+-.^_`|~` 与字母数字，出现 `=`、`/`、`+` 等字符
 * （Base64 令牌里极常见）时 `new WebSocket(url, ['token.ab+c/d=='])`
 * 会直接抛 `SyntaxError`，且抛出点在重连逻辑之外，整个连接链就此死掉。
 *
 * 因此协议名统一用 base64url 编码（字符集 A–Z a–z 0–9 - _，合法），
 * 前缀 `token.` 保持可读性。两端共用这一对函数，避免各自实现走偏。
 */

/**
 * 编码版本前缀。
 *
 * 必须显式区分「base64url 编码」与「旧版明文」，不能靠解码是否抛错判断：
 * `atob` 对 `secret-abc` 这类字符串也会成功，解出来是乱码，
 * 旧客户端会因此永远认证失败。
 */
const PREFIX = 'token.b64.';
const LEGACY_PREFIX = 'token.';

export function encodeWsTokenSubprotocol(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${PREFIX}${base64}`;
}

/** 从若干子协议里取出第一个 `token.` 项并解码；没有则返回 null */
export function decodeWsTokenSubprotocol(protocols: string | string[] | undefined): string | null {
  const list = Array.isArray(protocols) ? protocols : protocols ? protocols.split(',') : [];
  for (const raw of list) {
    const candidate = raw.trim();
    if (candidate.startsWith(PREFIX)) {
      const body = candidate.slice(PREFIX.length);
      if (!body) continue;
      try {
        const base64 = body.replace(/-/g, '+').replace(/_/g, '/');
        const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder().decode(bytes);
      } catch {
        continue;
      }
    }
    // 兼容旧客户端：`token.<明文>`（仅当明文本身是合法 token 字符时才会到达这里）
    if (candidate.startsWith(LEGACY_PREFIX)) {
      const body = candidate.slice(LEGACY_PREFIX.length);
      if (body) return body;
    }
  }
  return null;
}

/** 仅判断该子协议是否是本应用使用的令牌协议（用于握手时回选） */
export function isTokenSubprotocol(protocol: string): boolean {
  return protocol.startsWith(PREFIX) || protocol.startsWith(LEGACY_PREFIX);
}
