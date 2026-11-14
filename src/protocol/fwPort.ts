// Where a firmware session finds keyboards (DESIGN FW §3.3): the bootloader after `08 01`, the app after `08 04`. WebHID
// (hid.ts, filter 1CA6 / FFB0 / 1 without a product ID) or the demo's USB bus (mockFirmware.ts). A port only opens devices:
// opening sends nothing. What is sent to them (only `01 02` while probing) is decided in client.ts (fwAttach / fwFind).
import type { BaseTransport } from './client';

export interface FwPort {
  /** Every matching device the browser already allows, opened (the same transport object for the same device). */
  list(): Promise<BaseTransport[]>;
  /** The browser's chooser (needs a real click). The chosen devices, opened; empty when cancelled. */
  request(): Promise<BaseTransport[]>;
  /** A matching device was plugged in. */
  onConnect(cb: () => void): () => void;
  /** Close a transport the session does not keep (a probed keyboard that was not the one). */
  release(t: BaseTransport): Promise<void>;
  /**
   * A new connection to the same device. After `08 01` a connection only ever sends `01 02` (client.ts); when the keyboard did not
   * enter update mode (enterFail) the app gets a fresh one.
   */
  reopen(t: BaseTransport): Promise<BaseTransport>;
}
