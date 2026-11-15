/**
 * U-06: Disconnect, Change keyboard and the demo-model switch unmount the open page without a route change, so its
 * route guard never runs. A page that holds an unsaved draft (Macro, the Advanced tab) registers a gate here; those
 * three ask the gates first. A gate that holds a dirty draft asks its own leave question and returns true; it runs `go`
 * only after the user drops the draft ("Bỏ thay đổi"), and never on "Ở lại". A gate may also return true to refuse
 * outright (a macro write in flight), with its own toast.
 */
export type LeaveGate = (go: () => void) => boolean;

const gates = new Set<LeaveGate>();

export function registerLeaveGate(gate: LeaveGate): () => void {
  gates.add(gate);
  return () => { gates.delete(gate); };
}

/** True when a page took the leave over (asked, or refused); false when nothing holds a draft and the caller goes on. */
export function leaveTakenOver(go: () => void): boolean {
  for (const gate of [...gates]) if (gate(go)) return true;
  return false;
}
