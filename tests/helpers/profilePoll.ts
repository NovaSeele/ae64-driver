/**
 * True for the periodic active-profile read (`02 03 01`) sent by `watchKeyboardProfile` every `PROFILE_POLL_MS`
 * while the keyboard is idle. Real-timer tests that count all HID frames ignore only this exact frame.
 */
export function isProfilePoll(frame: Uint8Array | readonly number[]): boolean {
  return frame[0] === 0x02 && frame[1] === 0x03 && frame[2] === 0x01;
}
