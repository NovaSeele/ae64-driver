// DESIGN MKB §6.4, §16.2 (N5, v5): __fwTestSeam is gated on import.meta.env.MODE === 'test' (kills mutant MS).
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('__fwTestSeam MODE gate (MS)', () => {
  it('is undefined under production, desktop, and development, and defined under test', async () => {
    for (const mode of ['production', 'desktop', 'development'] as const) {
      vi.stubEnv('MODE', mode);
      vi.resetModules();
      const mod = await import('../src/protocol/client');
      expect(mod.__fwTestSeam, `MODE=${mode}`).toBeUndefined();
    }
    vi.unstubAllEnvs();
    vi.resetModules();
    const testMod = await import('../src/protocol/client');
    expect(testMod.__fwTestSeam, 'MODE=test').toBeDefined();
    expect(typeof testMod.__fwTestSeam?.newSession).toBe('function');
  });
});
