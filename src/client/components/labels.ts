import { CONTROL_BOUNDS } from '../../sim/config';
import { SCENARIOS } from '../../sim/scenarios';

export { CONTROL_BOUNDS };

export const SCENARIO_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(SCENARIOS).map(([k, v]) => [k, v.label]),
);

export function unitOf(key: string): string {
  return CONTROL_BOUNDS[key as keyof typeof CONTROL_BOUNDS]?.unit ?? '';
}

export function labelOf(key: string): string {
  return CONTROL_BOUNDS[key as keyof typeof CONTROL_BOUNDS]?.label ?? key;
}

export function precisionOf(key: string): number {
  return CONTROL_BOUNDS[key as keyof typeof CONTROL_BOUNDS]?.precision ?? 2;
}
