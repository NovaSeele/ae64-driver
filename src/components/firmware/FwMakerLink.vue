<script setup lang="ts">
// A link to a listed build's file on the maker's server (DESIGN OFU v1.7 §3.2). Web: an <a> to a new tab, no opener, no
// referrer, "(mở thẻ mới)". Desktop: a button that opens the system browser through one openUrl call, "(mở trong trình duyệt)".
import type { Component } from 'vue';
import Button from '../ui/Button.vue';
import { FW_DESKTOP } from '../../protocol/fwDownload';
import { t } from '../../i18n/vi';
import { openMakerUrl } from './makerLink';

withDefaults(defineProps<{ url: string; icon?: Component; variant?: 'primary' | 'secondary' | 'ghost'; size?: 'sm' | 'md' }>(), { variant: 'secondary', size: 'sm' });
const desktop = FW_DESKTOP;
</script>

<template>
  <Button v-if="desktop" :size="size" :variant="variant" :icon="icon" data-test="ofu-maker-link" @click="openMakerUrl(url)"><slot /><span class="sr-only"> {{ t('fw.on.newBrowser') }}</span></Button>
  <Button v-else :size="size" :variant="variant" :icon="icon" :href="url" data-test="ofu-maker-link"><slot /><span class="sr-only"> {{ t('fw.on.newTab') }}</span></Button>
</template>
