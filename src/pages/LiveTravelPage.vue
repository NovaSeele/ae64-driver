<script setup lang="ts">
// Placeholder — implemented in phase 2 (see docs/ARCHITECTURE.md, "Adding a page").
import { IconActivity } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import EmptyState from '../components/shell/EmptyState.vue';
import { t } from '../i18n/vi';
</script>

<template>
  <PageLayout :title="t('page.live')">
    <EmptyState :icon="IconActivity" />
  </PageLayout>
</template>
