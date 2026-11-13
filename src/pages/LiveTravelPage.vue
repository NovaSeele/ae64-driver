<script setup lang="ts">
// Kiểm tra phím. E step 5 (temporary): the Key test tab alone; the five-tab container replaces this page
// (DESIGN E §3.2).
import PageLayout from '../components/shell/PageLayout.vue';
import TestTab from '../components/live/TestTab.vue';
import { t } from '../i18n/vi';
</script>

<template>
  <PageLayout :title="t('page.live')">
    <TestTab />
  </PageLayout>
</template>
