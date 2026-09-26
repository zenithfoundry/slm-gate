import { detectHardware, recommendPreset, recommendNumCtx, getPresetRank, MIN_RAM_GB, modelsForRam, ramPresets } from '../hardware.js';

describe('hardware.ts', () => {
  it('detectHardware detects Apple Silicon', () => {
    const mockOs = {
      totalmem: () => 16 * 1024 * 1024 * 1024,
      arch: () => 'arm64',
      platform: () => 'darwin',
    };
    
    const hw = detectHardware(mockOs);
    expect(hw.totalRamGB).toBe(16);
    expect(hw.arch).toBe('arm64');
    expect(hw.platform).toBe('darwin');
    expect(hw.isAppleSilicon).toBe(true);
    expect(hw.accelerator).toBe('metal');
    expect(hw.unifiedMemory).toBe(true);
  });

  it('detectHardware detects non-Apple Silicon', () => {
    const mockOs = {
      totalmem: () => 32 * 1024 * 1024 * 1024,
      arch: () => 'x64',
      platform: () => 'linux',
    };
    
    const hw = detectHardware(mockOs);
    expect(hw.totalRamGB).toBe(32);
    expect(hw.arch).toBe('x64');
    expect(hw.platform).toBe('linux');
    expect(hw.isAppleSilicon).toBe(false);
    expect(hw.unifiedMemory).toBe(false);
    // Note: accelerator could be cuda or cpu depending on the host running the test, so we don't strictly test it here, or we accept either
    expect(['cpu', 'cuda']).toContain(hw.accelerator);
  });

  it('needs at least 16 GB of RAM', () => {
    expect(MIN_RAM_GB).toBe(16);
  });

  it.each([
    [16, 'ram-16'], [23, 'ram-16'],
    [24, 'ram-24'], [31, 'ram-24'],
    [32, 'ram-32'], [47, 'ram-32'],
    [48, 'ram-48'], [63, 'ram-48'],
    [64, 'ram-64'], [127, 'ram-64'],
    [128, 'ram-128'],
    [129, 'custom'], [192, 'custom'],
  ])('recommendPreset gives %i GB the %s preset (the size below it, and custom above 128 GB)', (ramGb, preset) => {
    expect(recommendPreset(ramGb)).toBe(preset);
  });

  it('recommendNumCtx gives 4096 below 24 GB and 8192 from 24 GB', () => {
    expect(recommendNumCtx(16)).toBe(4096);
    expect(recommendNumCtx(23)).toBe(4096);
    expect(recommendNumCtx(24)).toBe(8192);
    expect(recommendNumCtx(64)).toBe(8192);
    expect(recommendNumCtx(192)).toBe(8192);
  });

  it('getPresetRank works correctly', () => {
    expect(getPresetRank('ram-16')).toBe(16);
    expect(getPresetRank('ram-48')).toBe(48);
    expect(getPresetRank('ram-64')).toBe(64);
    expect(getPresetRank('custom')).toBe(24);
  });

  it('ramPresets holds one model pair per RAM size', () => {
    expect(ramPresets).toEqual({
      'ram-16':  { brain: 'qwen2.5-coder:3b', gate: 'qwen2.5-coder:0.5b' },
      'ram-24':  { brain: 'qwen3.5:4b',       gate: 'qwen2.5-coder:3b' },
      'ram-32':  { brain: 'qwen2.5:7b',       gate: 'qwen2.5-coder:3b' },
      'ram-48':  { brain: 'qwen3.5:9b',       gate: 'qwen2.5-coder:3b' },
      'ram-64':  { brain: 'qwen3.5:9b',       gate: 'qwen3.5:4b' },
      'ram-128': { brain: 'qwen3:14b',        gate: 'qwen3:8b' },
      'custom':  { brain: 'qwen3.5:4b',       gate: 'qwen2.5-coder:3b' },
    });
  });

  it('modelsForRam gives a size its preset pair, and more than 128 GB the 128 GB pair', () => {
    expect(modelsForRam(48)).toEqual(ramPresets['ram-48']);
    expect(modelsForRam(128)).toEqual(ramPresets['ram-128']);
    expect(modelsForRam(192)).toEqual(ramPresets['ram-128']);
  });
});
