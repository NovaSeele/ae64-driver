// Modifier key shown in the interface-size hint: Cmd on macOS, Ctrl elsewhere.
export function zoomModifier(platform: string): string {
  return /mac|iphone|ipad/i.test(platform) ? '⌘' : 'Ctrl';
}

/** The running browser's platform (userAgentData first, navigator.platform as fallback). */
export function currentPlatform(): string {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { userAgentData?: { platform?: string } });
  return nav?.userAgentData?.platform || nav?.platform || '';
}
