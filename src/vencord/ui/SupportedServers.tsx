// SPDX-License-Identifier: GPL-3.0-or-later
import { GuildStore, useState } from "@webpack/common";

import { ProjectIcon } from "./ProjectIcon";

const SERVERS = [
    { id: "530693013622489088", name: "Majestic", project: "mj" as const },
    { id: "1089530150540034181", name: "Россия Онлайн", project: "ro" as const },
    { id: "1395915167040016545", name: "Tech", project: null }
];

function Server({ server }: { server: typeof SERVERS[number]; }) {
    const [failed, setFailed] = useState(false);
    const hash = GuildStore.getGuild(server.id)?.icon;
    const icon = !failed && hash && /^[a-zA-Z0-9_]+$/.test(hash) ? `https://cdn.discordapp.com/icons/${server.id}/${hash}.png?size=32` : null;
    return <span className="vc-stx-supported-server">
        {icon ? <img src={icon} alt="" width={18} height={18} onError={() => setFailed(true)} /> : <ProjectIcon project={server.project} size={18} />}
        <span>{server.name}</span>
    </span>;
}

export function SupportedServers() {
    return <div className="vc-stx-supported-servers" aria-label="Серверы, на которых работает SupportTemplates">
        {SERVERS.map(server => <Server key={server.id} server={server} />)}
    </div>;
}
