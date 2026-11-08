import { describe, expect, it } from 'vitest';
import { checkFrame, checkPerformanceWrite, isWriteCommand, UnsafeCommandError, BLOCKED_KEYCODES } from '../src/protocol/safety';
import type { Performance } from '../src/protocol/types';
import { KEYCODE_GROUPS, comboKeycode } from '../src/protocol/keycodes';

const blocked = (p: number[], opts?: { readOnly?: boolean }) => expect(() => checkFrame(p, opts)).toThrow(UnsafeCommandError);
const ok = (p: number[], opts?: { readOnly?: boolean }) => expect(() => checkFrame(p, opts)).not.toThrow();

describe('checkFrame allow-list', () => {
  it('never lets firmware family 08 through', () => {
    for (let cmd = 0; cmd < 256; cmd++) blocked([0x08, cmd]);
  });

  it('refuses unknown families and commands', () => {
    blocked([0x00, 0x00]);
    blocked([0x09, 0x01]);
    blocked([0xff, 0xff]);
    blocked([0x01, 0x04]);
    blocked([0x02, 0x01]); // not used by the app
    blocked([0x02, 0x07, 0x00]);
    blocked([0x02, 0x06, 0x02]);
    blocked([0x04, 0x04, 1, 0]);
    blocked([]);
  });

  it('allows the commands the app uses', () => {
    ok([0x01, 0x02]);
    ok([0x02, 0x02, 2]);
    ok([0x03, 0x04, 0, 1, 0, 0x04, 0x00]);
    ok([0x04, 0x02, 3, 2, 1]);
    ok([0x04, 0x03, 1, 5]);
    ok([0x04, 0x02, 3, 2, 2]); // mode 2 frame; gated by protocol version in checkPerformanceWrite
    ok([0x05, 0x04, 0, 8]);
    ok([0x06, 0x02, 3, 1, 6, 3, 3]);
    ok([0x07, 0x04, 15, 0]);
  });

  it('range-checks arguments', () => {
    blocked([0x02, 0x02, 8]); // save group
    blocked([0x02, 0x03, 0x02, 4]); // profile 4
    blocked([0x02, 0x04, 0x02, 2]); // system mode
    blocked([0x02, 0x05, 0x02, 6]); // polling rate enum
    blocked([0x02, 0x10, 0x00, 2]);
    blocked([0x03, 0x04, 4, 1, 0]); // layer 4
    blocked([0x03, 0x04, 0, 0, 0]); // row 0
    blocked([0x03, 0x04, 0, 1, 21]); // col 21
    blocked([0x04, 0x02, 1, 0, 3]); // performance mode 3 (unknown)
    blocked([0x05, 0x02, 2, 0]); // area 2
    blocked([0x06, 0x02, 1, 0, 3]); // advanced type 3 (MT etc. are read-only here)
    blocked([0x06, 0x02, 1, 0, 6, 0, 0]); // SOCD partner row 0
    blocked([0x07, 0x02, 16]); // macro id 16
  });

  it('never writes factory-reset or wireless keycodes', () => {
    blocked([0x03, 0x04, 1, 1, 0, 0x00, 0xf2]); // F200 factory reset
    blocked([0x03, 0x04, 0, 1, 0, 0x06, 0xf4]); // F406 clear pairing
    ok([0x03, 0x04, 1, 1, 0, 0x01, 0x00]); // Transparent
    blocked([0x06, 0x02, 2, 2, 1, 0x04, 0, 0x00, 0xf2, 0, 0, 0, 0]); // DKS output F200
    blocked([0x06, 0x02, 2, 2, 2, 0x04, 0, 0x05, 0, 0x00, 0xf2]); // MPT output F200
    blocked([0x06, 0x02, 2, 2, 6, 2, 1, 0x04, 0, 0x00, 0xf2]); // SOCD output F200
    ok([0x06, 0x02, 2, 2, 6, 2, 1, 0x04, 0, 0x07, 0]);
  });

  it('blocks writes on read-only paths', () => {
    blocked([0x02, 0x02, 0], { readOnly: true });
    blocked([0x04, 0x02, 1, 0, 0], { readOnly: true });
    ok([0x04, 0x01, 1, 0], { readOnly: true });
    expect(isWriteCommand([0x03, 0x04, 0, 1, 0])).toBe(true);
    expect(isWriteCommand([0x03, 0x01, 0, 1])).toBe(false);
  });
});

const base: Performance = {
  mode: 0, normalPress: 1.5, normalRelease: 1.5, rtFirstTouch: 0.5, rtPress: 0.3, rtRelease: 0.3,
  pressDeadStroke: 0.1, releaseDeadStroke: 0.1, axis: 1, calibrate: 1, axisV2Id: 7, axisRangeMax: 3500, axisCoefficient: 120,
};

describe('checkPerformanceWrite', () => {
  it('requires a prior read', () => {
    expect(checkPerformanceWrite(base, [])).toMatch(/read/);
  });

  it('accepts normal edits', () => {
    expect(checkPerformanceWrite({ ...base, normalPress: 0.4 }, [base])).toBeNull();
    expect(checkPerformanceWrite({ ...base, mode: 1, rtFirstTouch: 0.2, rtPress: 0.1, rtRelease: 0.1 }, [base])).toBeNull();
  });

  it('never changes sensor fields', () => {
    expect(checkPerformanceWrite({ ...base, axisRangeMax: 0 }, [base])).toMatch(/axisRangeMax/);
    expect(checkPerformanceWrite({ ...base, axisCoefficient: 1 }, [base])).toMatch(/axisCoefficient/);
    expect(checkPerformanceWrite({ ...base, calibrate: 0 }, [base])).toMatch(/calibrate/);
    expect(checkPerformanceWrite({ ...base, axisV2Id: 0 }, [base])).toMatch(/axisV2Id/);
  });

  it('allows restoring sensor fields read earlier in the session', () => {
    const reset = { ...base, axisCoefficient: 100, normalPress: 2 };
    expect(checkPerformanceWrite(base, [base, reset])).toBeNull();
  });

  it('bounds travel distances by the key range', () => {
    expect(checkPerformanceWrite({ ...base, normalPress: 3.6 }, [base])).toMatch(/normalPress/);
    expect(checkPerformanceWrite({ ...base, normalPress: -1 }, [base])).toMatch(/normalPress/);
    expect(checkPerformanceWrite({ ...base, normalPress: Number.NaN }, [base])).toMatch(/normalPress/);
    expect(checkPerformanceWrite({ ...base, normalPress: 0 }, [base])).toMatch(/actuation/);
    expect(checkPerformanceWrite({ ...base, mode: 1, rtPress: 0 }, [base])).toMatch(/Rapid Trigger/);
  });

  it('writes mode 2 (RT without Continuous RT) only on protocol ≥ 1.3.0.0 or when the key already reported it', () => {
    const rt = { ...base, mode: 1 as const };
    expect(checkPerformanceWrite({ ...rt, mode: 2 }, [rt])).toMatch(/1\.3\.0\.0/);
    expect(checkPerformanceWrite({ ...rt, mode: 2 }, [rt], { intervalRt: true })).toBeNull();
    const interval = { ...base, mode: 2 as const };
    expect(checkPerformanceWrite({ ...interval, rtPress: 0.5 }, [interval])).toBeNull();
    expect(checkPerformanceWrite({ ...interval, rtPress: 0 }, [interval], { intervalRt: true })).toMatch(/Rapid Trigger/);
    expect(checkPerformanceWrite({ ...base, mode: 3 as never }, [base], { intervalRt: true })).toMatch(/mode 3/);
  });

  it('lets unchanged values through even if unusual', () => {
    const odd = { ...base, releaseDeadStroke: 0 , normalRelease: 0 };
    expect(checkPerformanceWrite({ ...odd, normalPress: 2 }, [odd])).toBeNull();
  });
});

describe('keycode guard for combos and firmware codes', () => {
  const setKey = (code: number) => [0x03, 0x04, 0, 1, 1, code & 0xff, code >> 8];

  it('refuses right-modifier combos that collide with firmware functions', () => {
    blocked(setKey(0xf404)); // mask 0xF4 + A = BT2 mode switch (blocked)
    blocked(setKey(0xf20b)); // unknown firmware code in the 0xF2 range
    blocked(setKey(0xf20a)); // Link (mask 0xF2 + G)
    blocked(setKey(0x1006)); // RCtrl+C
    expect(() => comboKeycode(0xf2, 0x05)).toThrow(RangeError);
    expect(() => comboKeycode(0x10, 0x06)).toThrow(RangeError);
    expect(() => comboKeycode(0x20, 0x6f)).toThrow(RangeError);
  });

  it('allows left-modifier combos', () => {
    ok(setKey(0x0306)); // Ctrl+Shift+C
    ok(setKey(comboKeycode(0x0f, 0x2a)));
  });

  it('refuses unknown codes with a high byte, also in advanced records', () => {
    blocked(setKey(0xbeef));
    blocked([0x06, 0x02, 1, 1, 2, 0xef, 0xbe, 0, 0, 0, 0]); // MPT with 0xBEEF
    ok([0x06, 0x02, 1, 1, 2, 0x06, 0x03, 0, 0, 0, 0]); // MPT with Ctrl+Shift+C
  });

  it('allows every catalogue code unless it is blocked', () => {
    for (const g of KEYCODE_GROUPS) {
      for (const e of g.codes) {
        if (BLOCKED_KEYCODES.has(e.code)) blocked(setKey(e.code));
        else ok(setKey(e.code));
      }
    }
  });
});

describe('macro meta guard (07 02)', () => {
  // [07 02 id valid countLo countHi repLo repHi mode]
  it('allows a valid meta, including Clear Data (0 actions)', () => {
    ok([0x07, 0x02, 3, 1, 31, 0, 12, 0, 1]);
    ok([0x07, 0x02, 3, 1, 0, 0, 1, 0, 0]);
    ok([0x07, 0x02, 15, 1, 0xc0, 0x03, 1, 0, 5]); // 960 actions, mode 5
  });
  it('refuses valid = 0, too many actions or an unknown mode', () => {
    blocked([0x07, 0x02, 3, 0, 0, 0, 1, 0, 0]);
    blocked([0x07, 0x02, 3, 1, 0xc1, 0x03, 1, 0, 0]); // 961
    blocked([0x07, 0x02, 3, 1, 1, 0, 1, 0, 6]);
    blocked([0x07, 0x02, 16, 1, 1, 0, 1, 0, 0]);
  });
});
