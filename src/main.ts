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
import { registerServiceWorker } from './update';

if (typeof document !== 'undefined') {
  document.documentElement.lang = locale.value;
}

registerServiceWorker();

const pinia = createPinia();
const app = createApp(App).use(pinia);
installFirmwareGuard(router, () => {
  const fw = useFirmwareStore(pinia);
  return { enabled: fw.enabled, active: fw.active, rescue: fw.rescue };
});
app.use(router).mount('#app');
