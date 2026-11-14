<script setup lang="ts">
// The coloured banner above the steps (DESIGN FW §3.1): done (green), rescue mode (red, an alert), AE64 Max (yellow, no steps).
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IconAlertOctagon, IconCircleCheck, IconInfoCircle, IconTarget } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import Card from '../ui/Card.vue';
import { useFirmwareStore } from '../../stores/firmware';
import { t } from '../../i18n/vi';

const props = defineProps<{ kind: 'done' | 'doneUnknown' | 'rescue' | 'noBoard' | 'max' }>();
const fw = useFirmwareStore();
const router = useRouter();
const title = ref<HTMLElement | null>(null);

const tone = computed(() => (props.kind === 'done' || props.kind === 'doneUnknown' ? 'ok' : props.kind === 'max' ? 'warn' : 'danger'));
const icon = computed(() => (tone.value === 'ok' ? IconCircleCheck : tone.value === 'warn' ? IconInfoCircle : IconAlertOctagon));
const heading = computed(() => {
  if (props.kind === 'done' || props.kind === 'doneUnknown') return t('fw.done.title', { version: fw.doneVersion });
  if (props.kind === 'max') return t('fw.max.title');
  return t('fw.rescue.title');
});
const body = computed(() => {
  if (props.kind === 'done') return t('fw.done.body');
  if (props.kind === 'doneUnknown') return t('fw.done.bodyUnknown', { version: fw.doneVersion });
  if (props.kind === 'max') return t('fw.max.body');
  return t(props.kind === 'noBoard' ? 'fw.rescue.noBoard' : 'fw.rescue.body');
});
const calibrate = () => void router.push({ path: '/performance', query: { tab: 'calibration' } });

/** The page moves the focus here when the update is done (DESIGN FW §2). */
function focus(behavior: ScrollBehavior): void {
  title.value?.scrollIntoView?.({ block: 'nearest', behavior });
  title.value?.focus({ preventScroll: true });
}
defineExpose({ focus });
</script>

<template>
  <Card class="fw-ban" :class="`fw-ban--${tone}`">
    <div class="fw-ban__row" :role="tone === 'danger' ? 'alert' : undefined">
      <component :is="icon" :size="22" stroke-width="1.75" aria-hidden="true" />
      <div>
        <h3 ref="title" class="fw-ban__t" tabindex="-1">{{ heading }}</h3>
        <p class="fw-ban__p">{{ body }}</p>
        <Button v-if="tone === 'ok'" class="fw-ban__btn" variant="primary" :icon="IconTarget" @click="calibrate">{{ t('fw.done.calib') }}</Button>
      </div>
    </div>
  </Card>
</template>

<style scoped>
.fw-ban { border-left: 3px solid var(--line-3); }
.fw-ban--ok { border-left-color: var(--ok); }
.fw-ban--warn { border-left-color: var(--warn); }
.fw-ban--danger { border-left-color: var(--danger); }
.fw-ban__row { display: flex; gap: var(--s-3); align-items: flex-start; }
.fw-ban__row > svg { flex: none; margin-top: 2px; }
.fw-ban--ok .fw-ban__row > svg { color: var(--ok); }
.fw-ban--warn .fw-ban__row > svg { color: var(--warn); }
.fw-ban--danger .fw-ban__row > svg { color: var(--danger); }
.fw-ban__t { margin: 0; font-size: var(--fs-body); font-weight: 600; color: var(--fg-1); }
.fw-ban__t:focus { outline: none; }
.fw-ban__t:focus-visible { box-shadow: var(--focus-ring); border-radius: 4px; }
.fw-ban__p { margin: 4px 0 0; font-size: var(--fs-label); line-height: 20px; color: var(--fg-2); }
.fw-ban__btn { margin-top: var(--s-3); }
</style>
