export type Variant = 'standalone' | 'vencord' | 'betterdiscord';
export type Channel = 'stable' | 'canary';
export type Phase = 'runtime' | 'startup' | 'app-closed';
export type Kind = 'native' | 'renderer';
export interface Config {
    schema: 1;
    version: string;
    channel: Channel;
    releaseRepository: string | null;
    manifestAsset: string;
    checkIntervalHours?: number;
}
export interface Asset {
    variant: Variant;
    platform: 'win32';
    kind: Kind;
    name: string;
    size: number;
    sha256: string;
    /** Required for renderer assets other than the self-contained BD plugin. */
    baseVersion?: string;
}
export interface Manifest {
    schema: 1;
    product: 'SupportTemplates';
    repository: string;
    version: string;
    channel: Channel;
    assets: Asset[];
}
export interface Pending {
    assetPath: string;
    manifest: Manifest;
    asset: Asset;
    version: string;
    variant: Variant;
    channel: Channel;
}
export interface ApplyContext extends Pending { phase: Phase; }
export interface Adapter {
    canApplyNative?(context: ApplyContext): boolean | Promise<boolean>;
    apply(context: ApplyContext): { applied: boolean; reason?: string } | Promise<{ applied: boolean; reason?: string }>;
}
export type Status = 'disabled' | 'idle' | 'up-to-date' | 'unavailable' | 'variant-unavailable' | 'staged' | 'pending' | 'pending-restart' | 'applied';
export interface Result {
    status: Status;
    version?: string;
    kind?: Kind;
    reloadRequired?: boolean;
    httpStatus?: number;
}
export interface Event extends Omit<Result, 'status'> { type: Status | 'error' | 'cache-invalid'; code?: string; }
export interface TransportResponse {
    status: number;
    headers?: Record<string, string | string[] | number | undefined>;
    body: AsyncIterable<Uint8Array> & { destroy?(): void };
}
/** Injectable host transport; defaults to anonymous node:https. */
export type Transport = (url: string, options: { signal: AbortSignal }) => Promise<TransportResponse>;
export interface Options {
    config: Config;
    variant: Variant;
    /** Actual selected installed version, including fallback; never use a receipt. */
    currentVersion?: string;
    baseVersion?: string;
    stagingDir: string;
    adapter: Adapter;
    onEvent?(event: Readonly<Event>): void;
    transport?: Transport;
    /** Total deadline per request including all redirects and body, max 120000. */
    timeoutMs?: number;
    /** May lower, never exceed, the default 256 MiB limit. */
    maxAssetBytes?: number;
}
export interface Updater {
    check(): Promise<Result>;
    start(): void;
    stop(): Promise<void>;
    applyPending(options?: { phase?: Phase }): Promise<Result>;
    getPending(): Promise<Pending | null>;
}
export function createUpdater(options: Options): Updater;
export function compareVersions(a: string, b: string): -1 | 0 | 1;
export const DEFAULTS: Readonly<{ intervalHours: 6; timeoutMs: 30000; maxAssetBytes: number; maxPages: 3 }>;
