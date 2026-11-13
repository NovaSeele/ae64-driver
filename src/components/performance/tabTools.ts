import type { InjectionKey, Ref } from 'vue';

/**
 * The Performance page toolbar's slot for the open tab's view tools (DESIGN E §3.2). A tab teleports its tools there
 * while it is active; an element rather than a `#ptab-tools` selector, so a page mounted outside the document (tests)
 * works the same.
 */
export const PTAB_TOOLS: InjectionKey<Ref<HTMLElement | null>> = Symbol('ptab-tools');
