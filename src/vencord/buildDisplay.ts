// SPDX-License-Identifier: GPL-3.0-or-later
// Presentation only: never use these strings for API compatibility or updates.
export const DISTRIBUTION_LABELS = {
    betterdiscord: "SupportTemplates",
    vencord: "SupportTemplates",
    standalone: "SupportTemplates Lite"
} as const;

export type Distribution = keyof typeof DISTRIBUTION_LABELS;

export function humanBuildVersion(version: string): string {
    // Only translate the known release channel. Preserve other prereleases rather
    // than accidentally presenting them as stable; retain metadata in the tooltip.
    const canary = /^(\d+\.\d+\.\d+)-canary\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
    return canary ? `${canary[1]} · тестовая` : version;
}

export function distributionDisplay(distribution: Distribution, version: string): string {
    return `${DISTRIBUTION_LABELS[distribution]} · ${humanBuildVersion(version)}`;
}
