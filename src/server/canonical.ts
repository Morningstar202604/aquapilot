import { createHash } from 'node:crypto';

/**
 * 稳定序列化：对象键按字典序递归排序，数组保持顺序。
 *
 * 哈希必须只依赖语义，不依赖 JS 对象的插入顺序；否则同一份拓扑从
 * JSON 读回后键序变化，就会产生不同的 provenance，幂等键也随之失效。
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value ?? null);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashJson(value: unknown): string {
  return sha256Hex(stableStringify(value));
}
