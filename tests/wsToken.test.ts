import { describe, expect, it } from 'vitest';
import { decodeWsTokenSubprotocol, encodeWsTokenSubprotocol, isTokenSubprotocol } from '../src/shared/wsToken';

/**
 * WebSocket 令牌子协议编码。
 *
 * 回归的是真实故障：令牌来自 Base64（含 `=`、`/`、`+`）时，
 * 把它直接拼进 `new WebSocket(url, ['token.' + token])` 会抛 SyntaxError，
 * 且抛出点在重连逻辑之外，整个应用从此连不上服务。
 */

const RFC7230_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

describe('WS 令牌子协议', () => {
  it('编码结果满足 RFC 7230 token 语法', () => {
    for (const token of ['sk-abc+/==', 'a/b+c=', '中文令牌', 'x'.repeat(200), 'plain']) {
      const proto = encodeWsTokenSubprotocol(token);
      expect(proto).toMatch(RFC7230_TOKEN);
      expect(isTokenSubprotocol(proto)).toBe(true);
    }
  });

  it('编码后可无损解码', () => {
    for (const token of ['sk-abc+/==', 'a/b+c=', '中文令牌', 'x'.repeat(200), 'plain', ' with space ']) {
      expect(decodeWsTokenSubprotocol(encodeWsTokenSubprotocol(token))).toBe(token);
    }
  });

  it('从多子协议里取出令牌项', () => {
    const proto = encodeWsTokenSubprotocol('secret');
    expect(decodeWsTokenSubprotocol(`chat, ${proto}, other`)).toBe('secret');
    expect(decodeWsTokenSubprotocol([proto])).toBe('secret');
  });

  it('没有令牌子协议时返回 null', () => {
    expect(decodeWsTokenSubprotocol(undefined)).toBeNull();
    expect(decodeWsTokenSubprotocol('chat, other')).toBeNull();
    expect(decodeWsTokenSubprotocol('token.')).toBeNull();
  });

  it('兼容旧的明文令牌子协议', () => {
    expect(decodeWsTokenSubprotocol('token.secret-abc')).toBe('secret-abc');
  });
});
