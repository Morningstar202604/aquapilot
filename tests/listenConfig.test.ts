import { describe, expect, it } from 'vitest';
import { isLoopbackHost, resolveListenConfig } from '../src/server/listenConfig';

describe('安全监听配置', () => {
  it('默认绑定 IPv4 loopback', () => {
    expect(resolveListenConfig({}).host).toBe('127.0.0.1');
  });

  it('识别 IPv4/IPv6 loopback', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.20.1.2')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });

  it('非 loopback 监听没有 token 时 fail-closed', () => {
    expect(() => resolveListenConfig({ HOST: '0.0.0.0' })).toThrow(/必须配置/);
    expect(() => resolveListenConfig({ HOST: '::' })).toThrow(/必须配置/);
  });

  it('端口合法时保留显式配置', () => {
    expect(resolveListenConfig({ PORT: '5217' }).port).toBe(5217);
  });

  it('非法端口回退到安全默认值', () => {
    expect(resolveListenConfig({ PORT: 'not-a-port' }).port).toBe(5173);
    expect(resolveListenConfig({ PORT: '70000' }).port).toBe(5173);
  });

  it('非 loopback 监听配置 token 时允许', () => {
    expect(resolveListenConfig({ HOST: '0.0.0.0', AQUAPILOT_VIEWER_TOKEN: 'configured' })).toMatchObject({
      host: '0.0.0.0',
      port: 5173,
    });
  });
});
