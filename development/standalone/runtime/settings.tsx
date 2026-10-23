/*
 * Adapted from Vencord's settings layout integration.
 * Copyright (c) 2022 Vendicated and Megumin
 * Copyright (c) 2026 SupportTemplates contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
import definePlugin from "@utils/types";
import { waitFor } from "@webpack";
import { NativeServiceSettings } from "../userplugins/supportTemplates/ui/NativeServiceSettings";
import { IconTemplates } from "../userplugins/supportTemplates/ui/svg";

let types = { SECTION: 1, SIDEBAR_ITEM: 2, PANEL: 3, CATEGORY: 5, CUSTOM: 19 };
waitFor(["SECTION", "SIDEBAR_ITEM", "PANEL", "CUSTOM"], value => types = value);

export default definePlugin({
    name: "Settings",
    description: "SupportTemplates settings entry",
    authors: [{ name: "Vencord and SupportTemplates contributors", id: 0n }],
    required: true,
    patches: [{ find: ".buildLayout().map", replacement: {
        match: /(\i)\.buildLayout\(\)(?=\.map)/, replace: "$self.buildLayout($1)"
    } }],
    buildLayout(builder: { key?: string; buildLayout(): any[]; }) {
        const layout = builder.buildLayout();
        if (builder.key !== "$Root" || !Array.isArray(layout) || layout.some(s => s?.key === "support_templates_section")) return layout;
        const panel = { key: "support_templates_panel", type: types.PANEL, useTitle: () => "SupportTemplates",
            buildLayout: () => [{ key: "support_templates_category", type: types.CATEGORY,
                buildLayout: () => [{ key: "support_templates_custom", type: types.CUSTOM,
                    Component: NativeServiceSettings, useSearchTerms: () => ["SupportTemplates", "шаблоны"] }] }] };
        const entry = { key: "support_templates", type: types.SIDEBAR_ITEM, useTitle: () => "SupportTemplates",
            icon: () => <IconTemplates size={20} />, buildLayout: () => [panel] };
        return [{ key: "support_templates_section", type: types.SECTION, useTitle: () => "SupportTemplates", buildLayout: () => [entry] }, ...layout];
    }
});
