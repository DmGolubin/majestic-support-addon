import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
// @ts-expect-error Build configuration utility has no generated declarations.
import { validateConfig } from '../distribution/config.mjs';

const { createUpdater } = createRequire(import.meta.url)('../distribution/updater/index.cjs');
const config = { schema: 1, version: '1.0.0-canary.2', channel: 'canary', releaseRepository: 'owner/releases',
    manifestAsset: 'support-templates-update.json', checkIntervalHours: 6 };

describe('q18Delivery build configuration matches the shipped updater contract', () => {
    it.each(['01.0.0-canary.2', '1.0.0-canary.02', '1.0.0-beta.2', '9007199254740992.0.0-canary.2'])(
        'rejects version %s at build preflight instead of shipping an updater that cannot start', version => {
            expect(() => validateConfig({ ...config, version })).toThrow();
        });
    it.each(['_owner/releases', 'owner_/releases', '-owner/releases', 'owner/.releases'])(
        'rejects repository %s consistently with runtime', releaseRepository => {
            expect(() => validateConfig({ ...config, releaseRepository })).toThrow();
        });
    it('does not let a JSON array impersonate a stable version', () => {
        expect(() => validateConfig({ ...config, channel: 'stable', version: ['1.0.0'] })).toThrow();
    });
    it.each([{ version: '1.0.0', channel: 'stable' }, { version: '1.0.0-canary.2', channel: 'canary' }])(
        'accepted $channel build configuration initializes its updater without disk or network work', selected => {
            const accepted = validateConfig({ ...config, ...selected });
            expect(() => createUpdater({ config: accepted, variant: 'standalone', stagingDir: process.cwd(),
                adapter: { apply: async () => ({ applied: false }) } })).not.toThrow();
        });
});
