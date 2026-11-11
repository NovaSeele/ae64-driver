/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
/** True in the desktop (Tauri) build, `vite build --mode desktop`. */
declare const __DESKTOP__: boolean;
declare const process: { env: Record<string, string | undefined> };

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readdirSync(
    path: string,
    options: { withFileTypes: true },
  ): Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  export function rmSync(path: string, options: { force: boolean }): void;
  export function readFileSync(path: string, encoding: string): string;
  export function writeFileSync(path: string, data: string, encoding: string): void;
}

declare module 'node:path' {
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
