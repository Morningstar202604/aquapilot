import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export type FileExists = (path: string) => boolean;

function candidates(environment: NodeJS.ProcessEnv, platformName: NodeJS.Platform): string[] {
  if (platformName === 'win32') {
    const pathApi = win32;
    const roots = [
      environment.ProgramFiles,
      environment['ProgramFiles(x86)'],
      environment.LOCALAPPDATA,
      environment.SystemDrive ? pathApi.join(environment.SystemDrive, '\\Program Files') : undefined,
      environment.SystemDrive ? pathApi.join(environment.SystemDrive, '\\Program Files (x86)') : undefined,
    ].filter((root): root is string => Boolean(root));
    return roots.flatMap((root) => [
      pathApi.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      pathApi.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]);
  }
  if (platformName === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  }
  const pathApi = posix;
  return [
    environment.CHROME_BIN,
    environment.CHROMIUM_BIN,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
    .filter((path): path is string => Boolean(path))
    .map((path) => pathApi.normalize(path));
}

export function resolveBrowserExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  platformName: NodeJS.Platform = process.platform,
  fileExists: FileExists = existsSync,
): string | undefined {
  const explicit = environment.AQUAPILOT_BROWSER_PATH?.trim();
  if (explicit) {
    if (!fileExists(explicit)) throw new Error('AQUAPILOT_BROWSER_PATH is not available');
    return explicit;
  }
  return candidates(environment, platformName).find(fileExists);
}
