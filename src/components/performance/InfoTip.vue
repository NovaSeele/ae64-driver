<script setup lang="ts">
// An (i) button that explains a control. The text is always in the DOM for screen readers (aria-describedby points at a
// visually hidden copy); the bubble is the visual version, shown on hover and on keyboard focus.
import { useId } from 'vue';
import { IconInfoCircle } from '@tabler/icons-vue';
import Tooltip from '../ui/Tooltip.vue';
import { t } from '../../i18n/vi';

withDefaults(defineProps<{ text: string; placement?: 'top' | 'bottom' }>(), { placement: 'bottom' });
const id = useId();
</script>

<template>
  <span class="info">
    <Tooltip :text="text" :placement="placement">
      <button type="button" class="info__btn" :aria-label="t('perf.info')" :aria-describedby="id">
        <IconInfoCircle :size="16" stroke-width="1.5" aria-hidden="true" />
      </button>
    </Tooltip>
    <span :id="id" class="sr-only">{{ text }}</span>
  </span>
</template>

<style scoped>
.info { display: inline-flex; flex: none; }
.info__btn {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--fg-3);
}
.info__btn:hover { color: var(--fg-1); }
</style>
