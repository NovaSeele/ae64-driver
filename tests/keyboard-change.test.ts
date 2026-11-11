// Per-connection resets: what one keyboard left in a store (macro load, import diff, flashed keys) must not reach the next.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useDiagnosticsStore } from '../src/stores/diagnostics';
import { useFlashStore } from '../src/stores/flash';
import { useMacroStore } from '../src/stores/macro';

describe('state reset when the keyboard changes', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('a macro load still running for the old keyboard does not block loading the new one', async () => {
    // Without `loadPromise = null` in the macro store's connection watch, load() keeps returning the stale promise.
    const device = useDeviceStore();
    await device.connectDemo('max');
    const macro = useMacroStore();
    const macroPackets: number[] = [];
    const stop = (device.transport as MockTransport).onPacket((e) => { if (e.dir === 'out' && e.bytes[0] === 7) macroPackets.push(e.bytes[1]); });
    const old = macro.load();
    // Switch only once the old load is really reading slots (and has not finished).
    for (let i = 0; i < 200 && !macroPackets.length; i++) await new Promise((r) => setTimeout(r, 1));
    stop();
    expect(macroPackets.length).toBeGreaterThan(0);
    expect(macro.loading).toBe(true);

    await device.connectDemo('pro');
    const pro = device.transport as MockTransport;
    const reads: number[] = [];
    pro.onPacket((e) => { if (e.dir === 'out' && e.bytes[0] === 7) reads.push(e.bytes[1]); });
    await old.catch(() => undefined);
    expect(macro.loaded).toBe(false);
    await macro.load();
    expect(reads.length).toBeGreaterThan(0);
    expect(macro.loaded).toBe(true);
  }, 20000);

  it('an import diff computed on one keyboard is gone after switching to another', async () => {
    // Without the connection watch in the diagnostics store, a Max diff stays restorable on the Pro.
    const device = useDeviceStore();
    await device.connectDemo('max');
    const diag = useDiagnosticsStore();
    await diag.parseAndDiffBackup(JSON.stringify({ schemaVersion: 1, boardIdHex: device.info!.boardIdHex }));
    expect(diag.importDiff).not.toBeNull();

    await device.connectDemo('pro');
    expect(diag.importDiff).toBeNull();
  }, 20000);

  it('flashed keys and their timers do not survive a keyboard change', async () => {
    // Without the connection watch in the flash store, a key of the old keyboard stays lit on the new one.
    const device = useDeviceStore();
    await device.connectDemo('max');
    const flash = useFlashStore();
    flash.flash([1, 2, 3], 60000); // outlives the switch
    expect(flash.isFlashing(1)).toBe(true);

    await device.connectDemo('pro');
    expect([1, 2, 3].some((id) => flash.isFlashing(id))).toBe(false);

    flash.flash([2], 300); // the new keyboard's own flash still works and expires
    await new Promise((r) => setTimeout(r, 250));
    expect(flash.isFlashing(2)).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(flash.isFlashing(2)).toBe(false);
  });
});
