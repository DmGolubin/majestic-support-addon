// SPDX-License-Identifier: GPL-3.0-or-later
// Presentation only: never use these strings for API compatibility or updates.
export const DISTRIBUTION_LABELS = {
    betterdiscord: "SupportTemplates",
    vencord: "SupportTemplates",
    standalone: "SupportTemplates Lite"
} as const;

export type Distribution = keyof typeof DISTRIBUTION_LABELS;

export function humanBuildVersion(version: string): string {
    // Support needs the exact installed build, including prerelease and metadata.
    return version;
}

export function distributionDisplay(_distribution: Distribution, version: string): string {
    return `SupportTemplates · Версия ${humanBuildVersion(version)}`;
}
