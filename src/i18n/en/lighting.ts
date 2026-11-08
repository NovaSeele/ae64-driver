// English strings for the lighting area. Must have exactly the keys of lightingVi (../lighting.ts).
import type { lightingVi } from '../lighting';

export const lightingEn: Record<keyof typeof lightingVi, string> = {
  // Navigation & tabs
  'lighting.tabKeys': 'Keyboard',
  'lighting.tabStrip': 'LED Strip',
  'lighting.tabsLabel': 'Select lighting zone',

  // Live preview
  'lighting.livePreview': 'Live preview',
  'lighting.livePreviewHint': 'Continuous read from keyboard (~10 Hz)',
  'lighting.liveStatus': 'Live',
  'lighting.pausedStatus': 'Paused',

  // Power / Open mode
  'lighting.powerTitle': 'Lighting Power',
  'lighting.powerKeysDesc': 'Control upper and lower LED banks of switches',
  'lighting.powerStripDesc': 'Turn the 38-LED perimeter strip on or off',
  'lighting.modeOff': 'Off',
  'lighting.modeBottom': 'Bottom',
  'lighting.modeTop': 'Top',
  'lighting.modeBoth': 'Both',
  'lighting.modeOn': 'On',

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
  'lighting.selectedKeys': '{count} keys selected',
  'lighting.noKeysSelected': 'No keys selected. Click or drag to select keys on the keyboard above.',
  'lighting.applyKeyColor': 'Apply color to keys',
  'lighting.clearKeyColor': 'Clear selected key overrides',
  'lighting.clearAllKeyColors': 'Clear all key overrides',
  'lighting.customActive': '{count} keys using custom colors',
  'lighting.spaceNote': 'Spacebar spans 5 RGB LEDs on the PCB; the color is synchronized across all 5 LEDs.',

  // Strip custom colors
  'lighting.stripTitle': 'Perimeter Strip (38 LEDs)',
  'lighting.stripSubtitle': 'Click LEDs on the bar to select',
  'lighting.stripCustomTitle': 'Per-LED Strip Colors',
  'lighting.stripCustomDesc': 'Assign static colors to individual LEDs on the 38-LED perimeter strip.',
  'lighting.selectedLeds': '{count} LEDs selected',
  'lighting.noLedsSelected': 'No LEDs selected. Click on the strip bar to select LEDs.',
  'lighting.selectAll': 'All',
  'lighting.selectNone': 'Deselect',
  'lighting.selectTop': 'Top',
  'lighting.selectBottom': 'Bottom',
  'lighting.selectLeft': 'Left',
  'lighting.selectRight': 'Right',
  'lighting.applyStripColor': 'Apply color to LEDs',
  'lighting.clearStripColor': 'Clear selected LED overrides',
  'lighting.clearAllStripColors': 'Clear all LED overrides',
  'lighting.stripCustomActive': '{count} LEDs using custom colors',

  // Loading & status
  'lighting.loading': 'Loading lighting settings…',
  'lighting.loadFailed': 'Failed to load lighting settings',
  'lighting.reload': 'Reload',

  // Sync labels for history / status
  'lighting.syncBase': 'Change lighting settings ({area})',
  'lighting.syncPalette': 'Change palette ({area})',
  'lighting.syncMatrix': 'Change LED colors ({area})',
};
