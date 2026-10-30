import { describe, expect, it } from 'vitest';
import {
  MODEL_DESCRIPTORS,
  asm1Descriptor,
  checkModelConservation,
  getModelDescriptor,
  listModelDescriptors,
  type RegisteredModelId,
} from '../src/sim/modelRegistry';

describe('model registry', () => {
  it('registers the three implemented models', () => {
    expect(Object.keys(MODEL_DESCRIPTORS).sort()).toEqual(['adm1', 'asm1', 'asm2d']);
  });

  it('every descriptor exposes id, name, components, processes', () => {
    for (const descriptor of listModelDescriptors()) {
      expect(descriptor.id.length).toBeGreaterThan(0);
      expect(descriptor.name.length).toBeGreaterThan(0);
      expect(descriptor.components.length).toBeGreaterThan(0);
      expect(descriptor.processes.length).toBeGreaterThan(0);
      expect(new Set(descriptor.components).size).toBe(descriptor.components.length);
      expect(new Set(descriptor.processes).size).toBe(descriptor.processes.length);
    }
  });

  it('getModelDescriptor returns the same shape as the map', () => {
    for (const id of Object.keys(MODEL_DESCRIPTORS) as RegisteredModelId[]) {
      expect(getModelDescriptor(id).id).toBe(id);
    }
  });

  it('ASM1 descriptor reuses the production stoichiometry (no second copy)', () => {
    const descriptor = asm1Descriptor();
    expect(descriptor.processes).toHaveLength(8);
    expect(descriptor.components).toHaveLength(13);
    // 自养行按专用判据豁免，其余行必须闭合
    const rows = checkModelConservation(descriptor);
    const failing = rows.filter((row) => !row.ok);
    expect(failing).toHaveLength(0);
  });

  it('conservation checker flags a deliberately broken row', () => {
    const descriptor = asm1Descriptor();
    const broken = {
      ...descriptor,
      stoichiometry: {
        ...descriptor.stoichiometry,
        // 人为把好氧异养生长的氧耗去掉一半 → COD 必然不闭合
        aerobic_growth_heterotrophs: {
          ...descriptor.stoichiometry.aerobic_growth_heterotrophs,
          S_O: (descriptor.stoichiometry.aerobic_growth_heterotrophs.S_O ?? 0) / 2,
        },
      },
      conservation: { ...descriptor.conservation, exempt: {} },
    };
    const rows = checkModelConservation(broken);
    expect(rows.find((row) => row.process === 'aerobic_growth_heterotrophs')?.ok).toBe(false);
  });

  it('ASM2d row count and ADM1 process list are exposed without loading a solver', () => {
    expect(getModelDescriptor('asm2d').processes).toHaveLength(19);
    expect(getModelDescriptor('adm1').processes.length).toBeGreaterThanOrEqual(15);
  });
});
