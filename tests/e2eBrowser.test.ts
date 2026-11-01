import { describe, expect, it } from 'vitest';
import { resolveBrowserExecutable } from '../scripts/e2eBrowser';

describe('浏览器可执行文件选择', () => {
  it('显式路径存在时优先使用它', () => {
    expect(
      resolveBrowserExecutable(
        { AQUAPILOT_BROWSER_PATH: '/custom/browser' },
        'linux',
        (path) => path === '/custom/browser',
      ),
    ).toBe('/custom/browser');
  });

  it('显式路径不存在时拒绝静默回退', () => {
    expect(() =>
      resolveBrowserExecutable({ AQUAPILOT_BROWSER_PATH: '/missing/browser' }, 'linux', () => false),
    ).toThrow(/not available/);
  });

  it('Windows 环境能发现已安装的 Edge', () => {
    const edge = String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
    expect(
      resolveBrowserExecutable(
        { 'ProgramFiles(x86)': String.raw`C:\Program Files (x86)` },
        'win32',
        (path) => path === edge,
      ),
    ).toBe(edge);
  });

  it('无可用系统浏览器时返回 undefined，让 Playwright 使用托管浏览器', () => {
    expect(resolveBrowserExecutable({}, 'linux', () => false)).toBeUndefined();
  });
});
