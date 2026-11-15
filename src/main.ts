import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/themes.css';
import './styles/base.css';
import App from './App.vue';
import { installFirmwareGuard, router } from './router';
import { useFirmwareStore } from './stores/firmware';
import { locale } from './i18n/locale';
import './theme';
import { installChunkGuard, registerServiceWorker, useUpdateStore } from './update';
import { CLOSE_BLOCKED_EVENT, installDesktopCloseGuard } from './data/desktopClose';
import { useCalibrationStore } from './stores/calibration';

if (typeof document !== 'undefined') {
  document.documentElement.lang = locale.value;
}

registerServiceWorker();

const pinia = createPinia();
const app = createApp(App).use(pinia);
// WX7 4a: a lazy chunk that fails to load shows "a newer version is installed" with a reload button; never a reload.
installChunkGuard(router, () => useUpdateStore(pinia).noteChunkFailed());
installFirmwareGuard(router, () => {
  const fw = useFirmwareStore(pinia);
  return { enabled: fw.enabled, active: fw.active, rescue: fw.rescue };
});
// The desktop window also holds its close while the keyboard may be calibrating (W-12, reader A).
installDesktopCloseGuard(() => useFirmwareStore(pinia).active || useCalibrationStore(pinia).holdsWindow);
if (typeof window !== 'undefined') {
  window.addEventListener(CLOSE_BLOCKED_EVENT, () => useCalibrationStore(pinia).onCloseBlocked());
  // W-12: a last `02 06 01` while calibrating when the page goes away (the flag covers a stop that never gets out).
  window.addEventListener('pagehide', () => useCalibrationStore(pinia).onPageHide());
}
app.use(router).mount('#app');
