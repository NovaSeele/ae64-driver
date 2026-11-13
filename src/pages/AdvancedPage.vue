<script setup lang="ts">
// Phím nâng cao. E step 3 (temporary): the Advanced tab alone; the five-tab container replaces this frame and its guard
// (DESIGN E §3.7). Leaving with a dirty draft asks with the tab's own dialog (no window.confirm).
import { ref } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import PageLayout from '../components/shell/PageLayout.vue';
import AdvancedTab from '../components/advanced/AdvancedTab.vue';
import { t } from '../i18n/vi';

const router = useRouter();
const cur = ref<InstanceType<typeof AdvancedTab> | null>(null);
onBeforeRouteLeave((to) => {
  if (!cur.value?.dirty) return;
  cur.value.askDiscard(() => void router.push(to.fullPath));
  return false;
});
</script>

<template>
  <PageLayout :title="t('page.advanced')">
    <AdvancedTab ref="cur" />
  </PageLayout>
</template>
