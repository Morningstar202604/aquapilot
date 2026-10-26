#!/usr/bin/env node
/**
 * AquaPilot Agent 配置 CLI。
 *
 * 用途：不开界面也能改配置，改完服务端会因文件 mtime 变化自动热加载。
 * 与界面、对话命令共用同一份 schema 与校验（normalizeAgentConfig），
 * 因此三端行为一致；权限与核心保护在这里同样生效。
 *
 * 用法：
 *   npx tsx scripts/agent-config.ts show
 *   npx tsx scripts/agent-config.ts set-persona --name 首席值班长 --tone 严谨详实
 *   npx tsx scripts/agent-config.ts add-skill --name 暴雨 --triggers 暴雨,storm --content "..."
 *   npx tsx scripts/agent-config.ts add-hook --name 越限提醒 --event alarm --match EFF_ --action notice --target "..."
 *   npx tsx scripts/agent-config.ts permission open
 *   npx tsx scripts/agent-config.ts set-constraint --max-step 45 --require-approval true
 *   npx tsx scripts/agent-config.ts reset
 */

import { readFileSync, mkdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  CONTROL_KEYS,
  defaultAgentConfig,
  normalizeAgentConfig,
  permissionAllows,
  type AgentConfig,
  type ControlKey,
  type HookAction,
  type HookEvent,
  type PermissionLevel,
} from '../src/shared/agentConfig';

const PATH = resolve(process.env.AQUAPILOT_AGENT_CONFIG ?? 'data/agent-config.json');

function load(): AgentConfig {
  if (!existsSync(PATH)) return defaultAgentConfig();
  const raw = JSON.parse(readFileSync(PATH, 'utf8')) as unknown;
  return normalizeAgentConfig(raw).config;
}

function save(config: AgentConfig): void {
  config.updatedAt = new Date().toISOString();
  config.updatedBy = 'cli';
  mkdirSync(dirname(PATH), { recursive: true });
  const staging = `${PATH}.staging-cli-${process.pid}`;
  writeFileSync(staging, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(staging, PATH);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireArgs(names: string[]): void {
  const missing = names.filter((n) => !arg(n));
  if (missing.length > 0) {
    console.error(`缺少参数：${missing.map((n) => `--${n}`).join(' ')}`);
    process.exit(2);
  }
}

function guard(config: AgentConfig): void {
  if (!permissionAllows(config.permission, 'save')) {
    console.error(`当前权限为「${config.permission}」，禁止写入。先执行：agent-config.ts permission standard|open`);
    process.exit(3);
  }
}

function main(): void {
  const cmd = process.argv[2];
  const config = load();

  if (!cmd || cmd === 'show') {
    console.log(`配置文件：${PATH}`);
    console.log(`权限：${config.permission}`);
    console.log(`角色：${config.persona.name}（${config.persona.role}，${config.persona.tone}）`);
    console.log(
      `提示词：${config.prompts.length} 条；技能：${config.skills.length} 个；钩子：${config.hooks.length} 个`,
    );
    console.log(
      `约束：单步 ≤${config.constraints.maxStepPct}% 量程，回复 ≤${config.constraints.maxAnswerChars} 字，人工确认 ${
        config.constraints.requireHumanApproval ? '开' : '关'
      }`,
    );
    console.log(`允许控制量：${config.constraints.allowedControls.join(', ')}`);
    return;
  }

  if (cmd === 'permission') {
    const level = process.argv[3] as PermissionLevel;
    if (!['readonly', 'standard', 'open'].includes(level)) {
      console.error('用法：permission <readonly|standard|open>');
      process.exit(2);
    }
    guard(config);
    if (level === 'open' && config.permission !== 'open') {
      console.error('提权到「完全放开」必须由已处于该档位的操作完成（防越权自升）。');
      process.exit(3);
    }
    config.permission = level;
    save(config);
    console.log(`权限已设为 ${level}`);
    return;
  }

  guard(config);

  if (cmd === 'set-persona') {
    config.persona.name = arg('name') ?? config.persona.name;
    config.persona.role = arg('role') ?? config.persona.role;
    const tone = arg('tone');
    if (tone === '专业简洁' || tone === '严谨详实' || tone === '亲和解释') config.persona.tone = tone;
    save(config);
    console.log(`角色已更新：${config.persona.name}`);
    return;
  }

  if (cmd === 'add-skill') {
    requireArgs(['name', 'content']);
    const triggers = (arg('triggers') ?? arg('name')!)
      .split(/[,，\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    config.skills.push({
      id: `s-cli-${Date.now().toString(36)}`,
      name: arg('name')!,
      description: arg('description') ?? '',
      triggers,
      content: arg('content')!,
      enabled: true,
      source: 'custom',
    });
    save(config);
    console.log(`已添加技能「${arg('name')}」`);
    return;
  }

  if (cmd === 'add-hook') {
    requireArgs(['name', 'event', 'action', 'target']);
    const event = arg('event') as HookEvent;
    const action = arg('action') as HookAction;
    if (!['alarm', 'decision', 'chat', 'config'].includes(event)) {
      console.error('event 只支持 alarm/decision/chat/config');
      process.exit(2);
    }
    if (!['notice', 'log', 'skill', 'webhook'].includes(action)) {
      console.error('action 只支持 notice/log/skill/webhook');
      process.exit(2);
    }
    if (action === 'webhook' && config.permission !== 'open') {
      console.error('webhook 钩子仅「完全放开」权限可用');
      process.exit(3);
    }
    config.hooks.push({
      id: `h-cli-${Date.now().toString(36)}`,
      name: arg('name')!,
      event,
      match: arg('match') ?? '',
      action,
      target: arg('target')!,
      level: 'info',
      enabled: true,
      cooldownMin: Number(arg('cooldown') ?? 5),
    });
    save(config);
    console.log(`已添加钩子「${arg('name')}」`);
    return;
  }

  if (cmd === 'add-prompt') {
    requireArgs(['title', 'body']);
    config.prompts.push({
      id: `p-cli-${Date.now().toString(36)}`,
      title: arg('title')!,
      body: arg('body')!,
      enabled: true,
    });
    save(config);
    console.log(`已添加提示词「${arg('title')}」`);
    return;
  }

  if (cmd === 'set-constraint') {
    const step = arg('max-step');
    if (step) config.constraints.maxStepPct = Number(step);
    const approval = arg('require-approval');
    if (approval) config.constraints.requireHumanApproval = approval === 'true';
    const allowed = arg('allowed-controls');
    if (allowed) {
      const list = allowed
        .split(/[,，\s]+/)
        .map((t) => t.trim())
        .filter((t): t is ControlKey => CONTROL_KEYS.includes(t as ControlKey));
      if (list.length === 0) {
        console.error(`未识别到合法控制量，可用：${CONTROL_KEYS.join(',')}`);
        process.exit(2);
      }
      config.constraints.allowedControls = list;
    }
    save(config);
    console.log('约束已更新');
    return;
  }

  if (cmd === 'reset') {
    save(defaultAgentConfig());
    console.log('已恢复默认配置');
    return;
  }

  console.error(`未知命令：${cmd}`);
  process.exit(2);
}

main();
