import config from "../../distribution/config.json";
export const PLUGIN_VERSION = config.version;
export const PLUGIN_BUILD = "BetterDiscord " + __STX_COMMIT__;
export const PLUGIN_DISTRIBUTION = "betterdiscord" as const;
