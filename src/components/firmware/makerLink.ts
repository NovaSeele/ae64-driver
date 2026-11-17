// The maker's file link in the desktop app (DESIGN OFU v1.7 §3.2): the webview's own target="_blank" is not relied on. One
// explicit call of tauri-plugin-opener's openUrl opens the system browser; its one permission, opener:allow-open-url, is scoped
// to https://hub.xsyd.top/storage/firmware/* (src-tauri/capabilities/default.json). The web build never calls it.
import { FW_DESKTOP } from '../../protocol/fwDownload';
import { allowedFileUrl } from '../../protocol/fwManifest';

/** Opens a listed build's file URL in the system browser (desktop only); false when it did not. */
export async function openMakerUrl(url: string): Promise<boolean> {
  // written out here (not only FW_DESKTOP) so the web build folds it to false and drops the plugin's code; the tests run in
  // mode 'test' and switch FW_DESKTOP themselves
  if (!((typeof __DESKTOP__ !== 'undefined' && __DESKTOP__) || import.meta.env.MODE === 'test')) return false;
  if (!FW_DESKTOP || !allowedFileUrl(url)) return false;
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return true;
  } catch {
    return false;
  }
}
