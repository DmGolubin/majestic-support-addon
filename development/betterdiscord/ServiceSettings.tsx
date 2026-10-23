// SPDX-License-Identifier: GPL-3.0-or-later
import { DiagnosticControls } from "../src/vencord/ui/DiagnosticControls";
import { React } from "./shims/common";
import "../src/vencord/ui/host-settings.css";

export function ServiceSettings({ active }: { active: boolean; }) {
    return <div className="stx-bd-service vc-stx-host-settings">
        <DiagnosticControls available={active} />
    </div>;
}
