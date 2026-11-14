<script setup lang="ts">
defineProps<{ title?: string; subtitle?: string }>();
</script>

<template>
  <section class="card">
    <header v-if="title || $slots.title || $slots.actions" class="card__head">
      <div>
        <h3 v-if="title || $slots.title" class="card__title"><slot name="title">{{ title }}</slot></h3>
        <p v-if="subtitle" class="card__sub">{{ subtitle }}</p>
      </div>
      <div v-if="$slots.actions" class="card__actions"><slot name="actions" /></div>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.card {
  background: var(--panel);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
  padding: var(--s-5);
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  min-width: 0;
}
.card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s-3); }
.card__title { font-size: var(--fs-card); font-weight: 600; }
.card__sub { margin-top: 2px; color: var(--fg-3); font-size: var(--fs-label); }
.card__actions { display: flex; gap: var(--s-2); align-items: center; }
</style>
