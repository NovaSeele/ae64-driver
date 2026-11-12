// Gamepad page edits that end in a toast with "Hoàn tác" (DESIGN K §5.1): assign, WASD, unassign, fit.
import { GP_TRAVEL_MAX_UM, GP_TRAVEL_MIN_UM } from '../../protocol/gamepad';
import { useDeviceStore } from '../../stores/device';
import { useGamepadStore } from '../../stores/gamepad';
import { useHistoryStore } from '../../stores/history';
import { useToast } from '../ui/toast';
import type { ToastAction } from '../ui/toast';
import { t } from '../../i18n/vi';
import { indexOfKey, keyLegend, longNameOf } from './outputs';

export function useGamepadActions() {
  const gp = useGamepadStore();
  const device = useDeviceStore();
  const history = useHistoryStore();
  const toast = useToast();

  /** "Hoàn tác" that undoes only the entry the toast reports (not a later edit). */
  function undoAction(): ToastAction {
    const id = history.undoId;
    return { label: t('gp.undo'), run: () => { if (history.undoId === id) history.undo(); } };
  }
  const done = (text: string) => toast.show(text, 'success', undefined, undoAction());
  const refused = () => toast.show(t('gp.invalid'), 'error');

  /** Output `index` → record key `key`, with the toast of DESIGN §5.1; false when refused (toast says why). */
  function assign(index: number, key: number): boolean {
    const r = gp.assign(index, key);
    const k = keyLegend(device, key);
    const out = longNameOf(index);
    if (!r.ok) {
      if (r.reason === 'noTravel') toast.show(t('gp.assignNoTravel', { key: k }), 'error');
      else refused();
      return false;
    }
    if (r.kind === 'moved') done(t('gp.moved', { out, from: keyLegend(device, r.fromKey), key: k }));
    else if (r.kind === 'replaced') done(t('gp.replaced', { out, key: k, old: longNameOf(r.oldIndex) }));
    else done(t('gp.assigned', { out, key: k }));
    return true;
  }

  function wasd(): boolean {
    if (gp.assignWasd()) {
      done(t('gp.wasdDone'));
      return true;
    }
    const bad = ['W', 'A', 'S', 'D'].find((n) => {
      const k = device.keys.find((d) => d.name === n);
      const i = k ? indexOfKey(k) : null;
      const um = i === null ? undefined : gp.travelUm(i);
      return um === undefined || um < GP_TRAVEL_MIN_UM || um > GP_TRAVEL_MAX_UM;
    });
    if (bad) toast.show(t('gp.assignNoTravel', { key: bad }), 'error');
    else refused();
    return false;
  }

  /** Unassign the outputs of these record keys (all when null). */
  function unassign(keys: readonly number[] | null): number {
    const n = gp.unassign(keys);
    if (n) done(t('gp.cleared', { n }));
    return n;
  }

  return { assign, wasd, unassign, undoAction };
}
