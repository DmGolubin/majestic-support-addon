// SPDX-License-Identifier: GPL-3.0-or-later
import { PLUGIN_BUILD, PLUGIN_DISTRIBUTION, PLUGIN_VERSION } from "../buildInfo";
import { distributionDisplay } from "../buildDisplay";

export function BuildIdentity() {
    return <p className="vc-stx-hint vc-stx-build-identity" title={`Версия: ${PLUGIN_VERSION} · ${PLUGIN_BUILD}`}>
        {distributionDisplay(PLUGIN_DISTRIBUTION, PLUGIN_VERSION)}
    </p>;
}
