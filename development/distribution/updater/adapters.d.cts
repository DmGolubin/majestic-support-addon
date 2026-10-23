import type { Adapter } from './index.cjs';
/** Atomic BetterDiscord replacement at startup/app-closed; runtime is deferred. */
export function createFileAdapter(options: { targetPath: string; canApplyNative?: Adapter['canApplyNative'] }): Adapter;
