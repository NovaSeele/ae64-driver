import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/themes.css';
import './styles/base.css';
import App from './App.vue';
import { router } from './router';
import { locale } from './i18n/locale';
import './theme';
import { registerServiceWorker } from './update';

if (typeof document !== 'undefined') {
  document.documentElement.lang = locale.value;
}

registerServiceWorker();

createApp(App).use(createPinia()).use(router).mount('#app');
