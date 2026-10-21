/* SPDX-License-Identifier: GPL-3.0-or-later */
export * as PluginManager from "@api/PluginManager";
export * as ChatButtons from "@api/ChatButtons";
// Webpack's ThemeStore discovery calls this bridge. Standalone has no custom theme loader.
export const Themes = { initQuickCssThemeStore() {} };
