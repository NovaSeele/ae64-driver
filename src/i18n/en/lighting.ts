// English strings for the lighting area. Must have exactly the keys of lightingVi (../lighting.ts).
import type { lightingVi } from '../lighting';

export const lightingEn: Record<keyof typeof lightingVi, string> = {
  // Navigation & tabs
  'lighting.tabKeys': 'Keyboard',
  'lighting.tabStrip': 'Edge strip',
  'lighting.tabsLabel': 'Select lighting zone',

  // Live preview
  'lighting.livePreview': 'Live preview',
  'lighting.livePreviewHint': 'Continuous read from keyboard (~10 Hz)',
  'lighting.liveStatus': 'Live',
  'lighting.pausedStatus': 'Paused',
  'lighting.liveError': 'Read error',

  // Power / Open mode
  'lighting.powerTitle': 'Lighting Power',
  'lighting.powerKeysDesc': 'Control upper and lower LED banks of switches',
  'lighting.powerStripDesc': 'Turn the 38-LED edge strip on or off',
  'lighting.modeOff': 'Off',
  'lighting.modeBottom': 'Bottom',
  'lighting.modeTop': 'Top',
  'lighting.modeBoth': 'Both',
  'lighting.modeOn': 'On',
  'lighting.readOnly': 'Board is not in write allowlist — view only, lighting cannot be changed.',
  'lighting.powerOffHint': 'Lighting is off. Turn it on in "Lighting Power" to change effect, brightness and colors.',

  // Effects
  'lighting.effectsTitle': 'Lighting Effects',
  'lighting.effectsDesc': 'Select an effect pattern for the active lighting zone.',
  'lighting.effectN': 'Effect {n}',
  'lighting.experimentalEffect': 'Experimental',

  // Tuning (Brightness, Speed, Direction)
  'lighting.tuningTitle': 'Effect Tuning',
  'lighting.tuningDesc': 'Adjust brightness, animation speed, and direction.',
  'lighting.brightness': 'Brightness',
  'lighting.speed': 'Speed',
  'lighting.direction': 'Direction',
  'lighting.directionForward': 'Forward',
  'lighting.directionBackward': 'Backward',

  // Palette
  'lighting.paletteTitle': 'Palette',
  'lighting.paletteDesc': 'Eight firmware colors. Slot 0 is Rainbow; slots 1–7 are customizable RGB colors.',
  'lighting.rainbow': 'Rainbow',
  'lighting.rainbowSlot': 'RGB Rainbow',
  'lighting.paletteSlot': 'Color {n}',
  'lighting.rainbowHint': 'Rainbow mode spectrum is computed automatically by firmware.',
  'lighting.editColor': 'Edit color {n}',
  'lighting.activeSlot': 'Selected: {name}',

  // Per-key custom colors
  'lighting.perKeyTitle': 'Per-Key Custom Colors',
  'lighting.perKeyDesc': 'Select keys on the keyboard to apply a static color override on top of the effect.',
  'lighting.selectedKeyOne': '1 key selected',
  'lighting.selectedKeys': '{count} keys selected',
  'lighting.noKeysSelected': 'No keys selected. Click or drag to select keys on the keyboard above.',
  'lighting.applyKeyColor': 'Apply color to keys',
  'lighting.clearKeyColor': 'Clear selected key overrides',
  'lighting.clearAllKeyColors': 'Clear all key overrides',
  'lighting.customActiveOne': '1 key using a custom color',
  'lighting.customActive': '{count} keys using custom colors',
  'lighting.confirmClearKeysTitle': 'Clear all key color overrides?',
  'lighting.confirmClearKeysBody': 'Every key goes back to following the base effect. You can undo with Ctrl+Z.',
  'lighting.spaceNote': 'Spacebar spans 5 RGB LEDs on the PCB; the color is synchronized across all 5 LEDs.',

  // Strip custom colors
  'lighting.stripTitle': 'Edge strip (38 LEDs)',
  'lighting.stripSubtitle': 'Click LEDs on the bar to select',
  'lighting.stripCustomTitle': 'Per-LED Colors',
  'lighting.stripCustomDesc': 'Assign static colors to individual LEDs on the 38-LED edge strip.',
  'lighting.selectedLedOne': '1 LED selected',
  'lighting.selectedLeds': '{count} LEDs selected',
  'lighting.noLedsSelected': 'No LEDs selected. Click on the strip bar to select LEDs.',
  'lighting.selectAll': 'All LEDs',
  'lighting.selectNone': 'Deselect LEDs',
  'lighting.selectTop': 'Top',
  'lighting.selectBottom': 'Bottom',
  'lighting.selectLeft': 'Left',
  'lighting.selectRight': 'Right',
  'lighting.applyStripColor': 'Apply color to LEDs',
  'lighting.clearStripColor': 'Clear selected LED overrides',
  'lighting.clearAllStripColors': 'Clear all LED overrides',
  'lighting.stripCustomActiveOne': '1 LED using a custom color',
  'lighting.stripCustomActive': '{count} LEDs using custom colors',
  'lighting.confirmClearStripTitle': 'Clear all LED color overrides?',
  'lighting.confirmClearStripBody': 'Every LED on the edge strip goes back to following the base effect. You can undo with Ctrl+Z.',

  // Loading & status
  'lighting.loading': 'Loading lighting settings…',
  'lighting.loadFailed': 'Failed to load lighting settings',
  'lighting.reload': 'Reload',

  // Sync labels for history / status
  'lighting.syncBase': 'Change lighting settings ({area})',
  'lighting.syncPalette': 'Change palette ({area})',
  'lighting.syncMatrix': 'Change LED colors ({area})',
};
