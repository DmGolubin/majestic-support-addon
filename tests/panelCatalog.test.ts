import { describe, expect, it, vi } from "vitest";
import { parseProfile, parseSnapshot } from "../src/core/panelCatalog";
import { PERSONAL_COLORS } from "../src/core/personal";
import { htmlToDiscordText } from "../src/vencord/panelHtml";

const date = "2026-10-18T10:00:00.000Z";
const profileWire = (): any => ({
    schemaVersion: 1, accountId: "123456789012345678", connectionId: "12345678-1234-1234-1234-123456789abc",
    name: "Support", projects: ["majestic", "russia-online"], scopes: ["profile:read", "faq:read", "personal:read", "folders:read"],
    permissionsRevision: "permissions-1", minimumPluginVersion: "1.0.0", serverTime: date,
});
const snapshotWire = (): any => ({
    schemaVersion: 1, accountId: "123456789012345678", revision: "snapshot-1", permissionsRevision: "permissions-1", serverTime: date,
    projects: ["majestic", "russia-online"],
    faq: [{ id: "majestic:1", version: "faq-v1", title: "Same title", text: "<p>FAQ answer</p>", format: "html", projects: ["majestic"], category: "Help", tags: ["login"], status: "actual", updatedAt: date }],
    personal: [{ id: "1", version: "personal-v1", title: "Same title", text: "**Hello** {{user_name}}\n[[greeting:end]]\n{{choice|a|b}}", format: "text", projects: ["majestic"], shared: false, command: "Fix.Login", color: "blue", folderId: "1", updatedAt: date }],
    folders: [{ id: "1", version: "folder-v1", title: "Folder", project: "majestic", position: 2, updatedAt: date }],
    trash: [], colorLabels: { blue: "Blue" }, limits: { colors: ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] },
});
const parse = (wire = snapshotWire(), profile = parseProfile(profileWire()), converter = htmlToDiscordText) => parseSnapshot(wire, profile, converter);

describe("panel profile", () => {
    it("maps wire projects and preserves the exact integration fields", () => {
        expect(parseProfile(profileWire())).toEqual({ ...profileWire(), projects: ["mj", "ro"] });
    });
    it.each(["accountId", "connectionId", "name", "projects", "scopes", "permissionsRevision", "schemaVersion", "minimumPluginVersion", "serverTime"])("requires %s despite incomplete OpenAPI required arrays", key => {
        const wire = profileWire(); delete wire[key];
        expect(() => parseProfile(wire)).toThrow();
    });
    it.each([
        { schemaVersion: 2 }, { accountId: 123 }, { accountId: "account-name" }, { connectionId: "bad" },
        { projects: ["mj"] }, { projects: ["majestic", "majestic"] }, { projects: ["eu"] },
        { scopes: ["faq:read"] }, { scopes: ["profile:read", "profile:read"] },
        { minimumPluginVersion: "1.0" }, { minimumPluginVersion: "01.0.0" }, { minimumPluginVersion: "1.0.0-01" },
        { serverTime: "2026-02-31T00:00:00Z" }, { serverTime: "2026-10-18T10:00:00+02:00" },
    ])("rejects invalid profile %j", patch => {
        expect(() => parseProfile({ ...profileWire(), ...patch })).toThrow();
    });
    it("accepts semver prerelease/build format without deciding client compatibility", () => {
        expect(parseProfile({ ...profileWire(), minimumPluginVersion: "10.0.0-rc.1+build.2" }).minimumPluginVersion).toBe("10.0.0-rc.1+build.2");
    });
});

describe("panel snapshot", () => {
    it("accepts the live text FAQ format and preserves Media links without HTML conversion", () => {
        const wire = snapshotWire();
        const text = "**Приветствую!\nБлагодарим Вас за обращение в службу поддержки.**\n[[greeting:end]]\n\nЛюбые вопросы по Media:\nСтать медиа проекта → [Majestic Media Bot](<https://t.me/majestic_media_bot>)\nВся коммуникация → [VK Majestic Media](<https://vk.com/majestic.media>)\nОфициальный канал \"Медиа\" → [Majestic GTA Media](<https://t.me/majesticgta_media>)";
        Object.assign(wire.faq[0], { format: "text", text });
        const converter = vi.fn(() => { throw Error("Text must not enter HTML conversion"); });
        expect(parse(wire, parseProfile(profileWire()), converter).templates[0].text).toBe(text);
        expect(converter).not.toHaveBeenCalled();
    });
    it("preserves literal text, entities, CRLF, indentation and markers in text FAQ", () => {
        const wire = snapshotWire();
        const text = "**Hello**\r\n[[greeting:end]]\r\n\r\n1. Step\r\n   detail\r\n\r\n\r\n`<div>` &amp; <https://example.org/?a=1&b=2>\r\n{{name=Player}} {|} help@example.org\r\n";
        Object.assign(wire.faq[0], { format: "text", text });
        expect(parse(wire).templates[0].text).toBe(text);
    });
    it("keeps the FAQ mention protection in text format without changing emails or token defaults", () => {
        const wire = snapshotWire();
        Object.assign(wire.faq[0], { format: "text", text: "@everyone @here <@123> <@!123> <@&123> help@example.org {{name=@here}}" });
        expect(parse(wire).templates[0].text).toBe("@\u200beveryone @\u200bhere <@\u200b123> <@\u200b!123> <@\u200b&123> help@example.org {{name=@here}}");
    });
    it.each(["text", "html"])("preserves URL destinations while protecting adjacent mentions in %s FAQ", format => {
        const wire = snapshotWire();
        const links = "[@here](https://example.org/@here/help)@everyone <https://example.org/@everyone> "
            + "[Help](<https://example.org/?user=@here&group=@everyone>) "
            + "https://example.org/(@here)/@everyone HTTP://example.org/@here";
        Object.assign(wire.faq[0], { format, text: links + " @here <@123> {{name=@here}}" });
        expect(parse(wire).templates[0].text).toBe(
            links.replace("[@here]", "[@\u200bhere]").replace(")@everyone", ")@\u200beveryone")
            + " @\u200bhere <@\u200b123> {{name=@here}}"
        );
    });
    it("converts only HTML in a mixed-format snapshot", () => {
        const wire = snapshotWire();
        wire.faq.push({ ...wire.faq[0], id: "russia-online:1", projects: ["russia-online"], format: "text", text: "**text**" });
        const converter = vi.fn(htmlToDiscordText);
        expect(parse(wire, parseProfile(profileWire()), converter).templates.slice(0, 2).map(t => t.text)).toEqual(["FAQ answer", "**text**"]);
        expect(converter).toHaveBeenCalledExactlyOnceWith(wire.faq[0].text);
    });
    it.each(["", " \n", "bad\u0000text", 123, null])("rejects invalid text FAQ content %j", text => {
        const wire = snapshotWire();
        Object.assign(wire.faq[0], { format: "text", text });
        expect(() => parse(wire)).toThrow();
    });
    it("rejects oversized text FAQ and missing format", () => {
        const wire = snapshotWire();
        Object.assign(wire.faq[0], { format: "text", text: "x".repeat(1000001) });
        expect(() => parse(wire)).toThrow();
        wire.faq[0].text = "Valid text";
        delete wire.faq[0].format;
        expect(() => parse(wire)).toThrow();
    });
    it("preserves FAQ Markdown and paragraphs through the real snapshot conversion", () => {
        const wire = snapshotWire();
        const text = "**Приветствую! Благодарим Вас за обращение в службу поддержки.**\n\nДля решения Вашей проблемы:\n\n1. Проверьте файлы.\n2. Обновите драйвера.\n\nid#00048394";
        wire.faq[0].text = "<div>" + text + "</div>";
        expect(parse(wire).templates[0].text).toBe(text);
    });
    it("returns a complete catalog, stable namespaces, personal object identity, folder and command", () => {
        const catalog = parse();
        expect(catalog).toMatchObject({ schemaVersion: 1, accountId: profileWire().accountId, revision: "snapshot-1", permissionsRevision: "permissions-1", serverTime: date, projects: ["mj", "ro"] });
        expect(catalog.templates.map(t => t.id)).toEqual(["faq:majestic:1", "personal:panel:1"]);
        expect(catalog.templates[1]).toBe(catalog.personal[0]);
        expect(catalog.personal[0]).toMatchObject({ command: "Fix.Login", color: "#3b82f6", folderId: "folder:panel:1", category: "Folder", text: snapshotWire().personal[0].text, updatedAt: date });
        expect(catalog.folders).toEqual([{ id: "folder:panel:1", name: "Folder" }]);
    });
    it("uses canonical FAQ IDs across renames, same-title records and regional numeric collisions", () => {
        const wire = snapshotWire(), before = parse(wire);
        wire.faq[0].title = "Renamed";
        wire.faq.push({ ...wire.faq[0], id: "russia-online:1", projects: ["russia-online"] });
        const after = parse(wire);
        expect(after.templates[0].id).toBe(before.templates[0].id);
        expect(after.templates.map(t => t.id)).toEqual(["faq:majestic:1", "faq:russia-online:1", "personal:panel:1"]);
    });
    it.each(["schemaVersion", "accountId", "revision", "permissionsRevision", "serverTime", "projects", "faq", "personal", "folders", "trash", "limits", "colorLabels"])("requires snapshot %s", key => {
        const wire = snapshotWire(); delete wire[key]; expect(() => parse(wire)).toThrow();
    });
    it.each([
        { accountId: "999999999999999999" }, { schemaVersion: 2 }, { permissionsRevision: "changed" },
        { projects: ["majestic"] }, { projects: ["majestic", "eu"] }, { faq: {} }, { personal: null },
    ])("rejects mismatched snapshot %j before conversion", patch => {
        const converter = vi.fn(() => "text");
        expect(() => parse({ ...snapshotWire(), ...patch }, parseProfile(profileWire()), converter)).toThrow();
        expect(converter).not.toHaveBeenCalled();
    });
    it.each(["faq:read", "personal:read", "folders:read"])("requires %s", scope => {
        const wire = profileWire(); wire.scopes = wire.scopes.filter((s: string) => s !== scope);
        expect(() => parse(snapshotWire(), parseProfile(wire))).toThrow();
    });
    it.each(["faq", "personal", "folders"])("rejects duplicate %s IDs rather than silently deduplicating", key => {
        const wire = snapshotWire(); wire[key].push({ ...wire[key][0] }); expect(() => parse(wire)).toThrow();
    });
    it.each([
        ["faq", { id: "same title" }], ["faq", { id: "russia-online:1" }], ["faq", { projects: [] }],
        ["faq", { projects: ["majestic", "russia-online"] }], ["faq", { format: "markdown" }], ["faq", { status: "unknown" }],
        ["faq", { tags: "help" }], ["faq", { version: 1 }], ["personal", { id: "personal:1" }],
        ["personal", { format: "html" }], ["personal", { shared: "false" }], ["personal", { folderId: "missing" }],
        ["personal", { command: "with space" }], ["personal", { command: "/cmd" }], ["personal", { text: "x".repeat(20001) }],
        ["folders", { project: "eu" }], ["folders", { position: -1 }], ["folders", { title: "x".repeat(121) }],
    ])("rejects invalid %s fields %j", (key, patch) => {
        const wire = snapshotWire(); Object.assign(wire[key as string][0], patch); expect(() => parse(wire)).toThrow();
    });
    it("accepts a redacted FAQ status and preserves explicit review status", () => {
        const wire = snapshotWire(); delete wire.faq[0].status;
        expect(parse(wire).templates[0].status).toBe("actual");
        wire.faq[0].status = "needs_review";
        expect(parse(wire).templates[0].status).toBe("needs_review");
    });
    it("fails closed when entry projects exceed the profile", () => {
        const p = profileWire(); p.projects = ["majestic"];
        const wire = snapshotWire(); wire.projects = ["majestic"];
        wire.personal[0].projects = ["majestic", "russia-online"]; wire.personal[0].shared = true;
        expect(() => parse(wire, parseProfile(p))).toThrow();
    });
    it("uses shared scope only when both projects are explicitly authorised", () => {
        const wire = snapshotWire(); wire.personal[0].shared = true; wire.personal[0].projects = ["majestic", "russia-online"];
        expect(parse(wire).personal[0].project).toBeNull();
        wire.personal[0].shared = false; expect(() => parse(wire)).toThrow();
        wire.personal[0].shared = true; wire.personal[0].projects = ["majestic"]; wire.projects = ["majestic"];
        const p = profileWire(); p.projects = ["majestic"];
        expect(parse(wire, parseProfile(p)).personal[0].project).toBe("mj");
    });
    it("keeps 120-character folder names, stable position order, and validates folder ownership", () => {
        const wire = snapshotWire(); wire.folders[0].title = "x".repeat(120);
        wire.folders.push({ ...wire.folders[0], id: "2", title: "First", position: 0 });
        expect(parse(wire).folders.map(f => f.name)).toEqual(["First", "x".repeat(120)]);
        wire.folders[0].project = "russia-online";
        expect(() => parse(wire)).toThrow();
    });
    it("maps declared colors only to supported palette values, never raw CSS", () => {
        for (const color of snapshotWire().limits.colors) {
            const wire = snapshotWire(); wire.personal[0].color = color;
            expect(PERSONAL_COLORS).toContain(parse(wire).personal[0].color);
        }
        const wire = snapshotWire(); wire.personal[0].color = null;
        expect(parse(wire).personal[0].color).toBeNull();
        wire.personal[0].color = "#3b82f6"; expect(() => parse(wire)).toThrow();
        wire.personal[0].color = "blue"; wire.limits.colors = ["red"]; expect(() => parse(wire)).toThrow();
        wire.limits.colors = { blue: "server metadata" }; expect(parse(wire).personal[0].color).toBe("#3b82f6");
        wire.personal[0].color = "future-color"; wire.limits.colors = ["future-color"];
        expect(parse(wire).personal[0].color).toBeNull();
    });
    it("converts only FAQ HTML and masks converter failures without exposing payloads", () => {
        const wire = snapshotWire(), converter = vi.fn(() => "Converted");
        expect(parse(wire, parseProfile(profileWire()), converter).templates[0].text).toBe("Converted");
        expect(converter).toHaveBeenCalledExactlyOnceWith(wire.faq[0].text);
        for (const bad of [() => "", () => null as any, () => { throw Error("PRIVATE_CONTENT"); }]) {
            expect(() => parse(wire, parseProfile(profileWire()), bad)).toThrow("Некорректный каталог");
            try { parse(wire, parseProfile(profileWire()), bad); } catch (e) { expect(String(e)).not.toContain("PRIVATE_CONTENT"); }
        }
    });
    it("whole replacement removes missing FAQ, personal records and folders without mutating the old catalog", () => {
        const before = parse(), wire = snapshotWire();
        wire.revision = "snapshot-2"; wire.faq = []; wire.personal = []; wire.folders = [];
        wire.trash = [{ id: "1", version: "deleted", title: "Deleted", text: "Not usable", projects: ["majestic"], shared: false, color: null, command: null, purgeAt: date }];
        const replacement = parse(wire);
        expect(replacement.templates).toEqual([]); expect(replacement.personal).toEqual([]); expect(replacement.folders).toEqual([]);
        expect(before.templates).toHaveLength(2); expect(before.folders).toHaveLength(1);
        wire.personal = snapshotWire().personal; wire.folders = snapshotWire().folders;
        expect(() => parse(wire)).toThrow(); // same record cannot be both live and trash
    });
});
