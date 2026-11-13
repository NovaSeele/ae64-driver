<script lang="ts">
export { deriveRtLinked } from '../components/performance/TravelTab.vue';
</script>

<script setup lang="ts">
// Hiệu năng. E step 2 (temporary): the Travel tab alone, with its view tools in the toolbar; the five-tab container
// replaces this frame (DESIGN E §3.2).
import { provide, ref } from 'vue';
import PageLayout from '../components/shell/PageLayout.vue';
import TravelTab from '../components/performance/TravelTab.vue';
import { PTAB_TOOLS } from '../components/performance/tabTools';
import { t } from '../i18n/vi';

const tools = ref<HTMLElement | null>(null);
provide(PTAB_TOOLS, tools);
</script>

<template>
  <PageLayout :title="t('page.performance')">
    <template #toolbar><div ref="tools" class="ph__tools" /></template>
    <TravelTab />
  </PageLayout>
</template>

<style scoped>
.ph__tools { width: 100%; }
</style>
