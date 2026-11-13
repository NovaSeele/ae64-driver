// English strings for the lighting area. Must have exactly the keys of lightingVi (../lighting.ts).
import type { lightingVi } from '../lighting';

export const lightingEn: Record<keyof typeof lightingVi, string> = {
  // Navigation & tabs
  'lighting.tabKeys': 'Keyboard',
  'lighting.tabStrip': 'Edge strip',
  'lighting.tabKeysSub': 'LEDs above and below each key',
  'lighting.tabStripSub': '38 LEDs around the case edge',
  'lighting.tabsLabel': 'Select lighting zone',
  'lighting.ringLabel': 'Edge strip, 38 LEDs',
  'lighting.ledLabel': 'LED {n}, {side}',
  'lighting.sideTop': 'top edge',
  'lighting.sideRight': 'right edge',
  'lighting.sideBottom': 'bottom edge',
  'lighting.sideLeft': 'left edge',

  // Live preview
  'lighting.livePreview': 'Live preview',
  'lighting.livePreviewHint': 'Continuous read from keyboard (up to ~60 Hz)',
  'lighting.liveStatus': 'Live',
  'lighting.simStatus': 'Simulated',
  'lighting.pausedStatus': 'Paused',
  'lighting.liveError': 'Read error',

  // Power / Open mode
  'lighting.powerTitle': 'Lighting Power',
  'lighting.modeOff': 'Off',
  'lighting.modeBottom': 'Bottom',
  'lighting.modeTop': 'Top',
  'lighting.modeBoth': 'Both',
  'lighting.modeOn': 'On',
  'lighting.readOnly': 'Board is not in write allowlist — view only, lighting cannot be changed.',
  'lighting.powerHintKeys': 'Each key has LEDs below and above it; choose which light up.',
  'lighting.powerHintStrip': 'Turn the edge strip on or off.',
  'lighting.powerOffHint': 'Lighting is off. Turn it on in "Lighting Power" to change effect, brightness and colors.',

  // Effects
  'lighting.effectsTitle': 'Lighting Effects',
  'lighting.effectsShort': 'Effects',
  'lighting.effectsDesc': 'Select an effect pattern for the active lighting zone.',
  'lighting.demoSimNote': 'Demo: the preview only simulates motion so you can see how effect, brightness, speed, direction and color change it. On a real keyboard it reads the LEDs straight from the keyboard, so effects may look different.',
  'lighting.effectN': 'Effect {n}',
  'lighting.experimentalEffect': 'Experimental',

  // Tuning (Brightness, Speed, Direction)
  'lighting.tuningTitle': 'Effect Tuning',
  'lighting.tuningShort': 'Adjust',
  'lighting.tuningDesc': 'Adjust brightness, animation speed, and direction.',
  'lighting.brightness': 'Brightness',
  'lighting.speed': 'Speed',
  'lighting.direction': 'Direction',
  'lighting.directionShort': 'Direction',
  'lighting.directionForward': 'Forward',
  'lighting.directionBackward': 'Backward',

  // Palette
  'lighting.paletteTitle': 'Palette',
  'lighting.paletteDesc': 'Eight firmware colors. Slot 0 is Rainbow; slots 1–7 are customizable RGB colors.',
  'lighting.rainbow': 'Rainbow',
  'lighting.rainbowSlot': 'RGB Rainbow',
  'lighting.paletteSlot': 'Color {n}',
  'lighting.rainbowHint': 'Rainbow mode spectrum is computed automatically by firmware.',
  'lighting.editColorBtn': 'Edit…',
  'lighting.editColorAria': 'Edit color {n}',
  'lighting.editColorTitle': 'Edit color {n} · {area} palette',
  'lighting.activeSlot': 'Selected: {name}',

  // Per-key custom colors
  'lighting.perKeyTitle': 'Per-Key Custom Colors',
  'lighting.perKeyDesc': 'Select keys on the keyboard to apply a static color override on top of the effect.',
  'lighting.selectedKeyOne': '1 key selected',
  'lighting.selectedKeys': '{count} keys selected',
  'lighting.pickColor': 'Pick a color',
  'lighting.applyKeysN': 'Apply to {count|# key|# keys}',
  'lighting.applyLedsN': 'Apply to {count|# LED|# LEDs}',
  'lighting.applyColor': 'Apply color',
  'lighting.clearShort': 'Clear',
  'lighting.clearAll': 'Clear all custom colors…',
  'lighting.clearAllN': 'Clear all custom colors ({count})…',
  'lighting.clearKeyColor': 'Clear selected key overrides',
  'lighting.clearAllKeyColors': 'Clear all key overrides',
  'lighting.confirmClearKeysTitle': 'Clear all key color overrides?',
  'lighting.confirmClearKeysBody': 'Every key goes back to following the base effect. You can undo with Ctrl+Z.',
  'lighting.spaceNote': 'Spacebar spans 5 RGB LEDs on the PCB; the color is synchronized across all 5 LEDs.',

  // Strip custom colors
  'lighting.stripHint': 'Click an LED on the edge to select or deselect it',
  'lighting.stripCustomTitle': 'Per-LED Colors',
  'lighting.stripCustomDesc': 'Assign static colors to individual LEDs on the 38-LED edge strip.',
  'lighting.selectedLedNone': 'No LEDs selected',
  'lighting.selectedLedOne': '1 LED selected',
  'lighting.selectedLeds': '{count} LEDs selected',
  'lighting.selectTop': 'Top',
  'lighting.selectBottom': 'Bottom',
  'lighting.selectLeft': 'Left',
  'lighting.selectRight': 'Right',
  'lighting.clearStripColor': 'Clear selected LED overrides',
  'lighting.clearAllStripColors': 'Clear all LED overrides',
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
  'lighting.showsLive': 'LED colors read live',
  'lighting.showsSim': 'simulated LED colors',
  'lighting.showsSaved': 'LED colors from the settings',
  'lighting.showsOwn': 'own color',
};
