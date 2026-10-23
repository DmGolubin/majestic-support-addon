// SPDX-License-Identifier: GPL-3.0-or-later
import { BuildIdentity } from "./BuildIdentity";
import { DiagnosticControls } from "./DiagnosticControls";
import "./host-settings.css";

export function NativeServiceSettings() {
    const active = !!document.getElementById("vc-stx-host");
    return <div className="vc-stx-native-settings vc-stx-host-settings">
        <BuildIdentity />
        <DiagnosticControls available={active} />
    </div>;
}
