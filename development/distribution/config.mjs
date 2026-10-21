import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import validation from './updater/validation.cjs';

export function validateConfig(config, requireRepository = false) {
    if (config.schema !== 1 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(config.version)) throw new Error('Invalid distribution version');
    try { validation.version(config.version); } catch { throw new Error('Invalid distribution version'); }
    if (!['stable', 'canary'].includes(config.channel)) throw new Error('Invalid release channel');
    if (!validation.inChannel(config.version, config.channel)) throw new Error('Version and release channel disagree');
    if (config.releaseRepository !== null) {
        try { validation.repository(config.releaseRepository); } catch { throw new Error('Invalid release repository'); }
    }
    if (requireRepository && !config.releaseRepository) throw new Error('Choose a public releaseRepository in distribution/config.json before publishing');
    if (config.manifestAsset !== 'support-templates-update.json') throw new Error('Unexpected manifest name');
    if (!Number.isInteger(config.checkIntervalHours) || config.checkIntervalHours < 1 || config.checkIntervalHours > 168) throw new Error('Invalid update interval');
    return config;
}

export function readConfig(requireRepository = false) {
    return validateConfig(JSON.parse(fs.readFileSync(fileURLToPath(new URL('./config.json', import.meta.url)), 'utf8')), requireRepository);
}
