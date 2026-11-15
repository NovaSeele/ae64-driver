// Arrow keys on a role="radiogroup" of buttons, the way Segmented does it (WAI-ARIA radio group): ←/↑ and →/↓ move the choice
// to the previous / next enabled radio (wrapping), Home / End to the first / last; the choice follows focus (the radio's own
// click runs). With `radioTabindex` the group is one Tab stop, on the checked radio (the first one when none is checked).

/** keydown on the radiogroup element. */
export function onRadioGroupKey(e: KeyboardEvent): void {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const group = e.currentTarget as HTMLElement | null;
  if (!group) return;
  const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')].filter((r) => !r.disabled);
  const at = radios.indexOf(e.target as HTMLButtonElement);
  if (at < 0) return;
  const n = radios.length;
  let to: number;
  switch (e.key) {
    case 'ArrowRight': case 'ArrowDown': to = (at + 1) % n; break;
    case 'ArrowLeft': case 'ArrowUp': to = (at - 1 + n) % n; break;
    case 'Home': to = 0; break;
    case 'End': to = n - 1; break;
    default: return;
  }
  e.preventDefault();
  const next = radios[to];
  next.focus();
  if (next.getAttribute('aria-checked') !== 'true') next.click();
}

/** Roving tabindex of one radio: 0 on the checked one, or on the first when none is checked. */
export function radioTabindex(checked: boolean, index: number, anyChecked: boolean): 0 | -1 {
  return checked || (!anyChecked && index === 0) ? 0 : -1;
}
