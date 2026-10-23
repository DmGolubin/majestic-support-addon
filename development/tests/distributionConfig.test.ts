import { describe, expect, it } from 'vitest';
// @ts-expect-error Node build utility has no generated declarations.
import { validateConfig } from '../distribution/config.mjs';

const valid = { schema: 1, version: '0.1.0-canary.14', channel: 'canary', releaseRepository: null, manifestAsset: 'support-templates-update.json', checkIntervalHours: 6 };
describe('distribution release configuration', () => {
    it('allows an explicitly offline local package but prevents publishing it', () => {
        expect(validateConfig(valid)).toEqual(valid);
        expect(() => validateConfig(valid, true)).toThrow('public releaseRepository');
    });
    it('binds production channel to production version', () => {
        expect(() => validateConfig({ ...valid, channel: 'stable' })).toThrow('disagree');
        expect(() => validateConfig({ ...valid, version: '1.0.0' })).toThrow('disagree');
    });
    it.each(['https://github.com/owner/repo', '../repo', 'owner/repo?token=x', 'owner/repo/extra'])('rejects repository input %s', releaseRepository => {
        expect(() => validateConfig({ ...valid, releaseRepository }, true)).toThrow();
    });
    it('accepts an explicit GitHub repository for publication', () => {
        expect(validateConfig({ ...valid, releaseRepository: 'skyjacc/support-templates-releases' }, true).releaseRepository).toBe('skyjacc/support-templates-releases');
    });
});
