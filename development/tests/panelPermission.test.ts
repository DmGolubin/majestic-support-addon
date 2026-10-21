import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { PANEL_ORIGIN } from "../src/core/panelProtocol";

const compiled = ts.transpileModule(readFileSync(new URL("../src/vencord/panelPermission.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
function harness(allowed = false, result = "ok") {
    const native = { isDomainAllowed: vi.fn(async () => allowed), requestAddOverride: vi.fn(async () => result) };
    const exports: any = {};
    runInNewContext(compiled, { exports, require: () => ({ PANEL_ORIGIN }), VencordNative: { csp: native }, IS_WEB: false });
    return { native, ensure: exports.ensurePanelPermission };
}
describe("panel host permission", () => {
    it("never prompts during automatic session restore", async () => {
        const h = harness();
        expect(await h.ensure(false)).toBe("required");
        expect(h.native.requestAddOverride).not.toHaveBeenCalled();
    });
    it("requests only connections to the fixed panel host and waits for restart", async () => {
        const h = harness();
        expect(await h.ensure(true)).toBe("restart");
        expect(h.native.requestAddOverride).toHaveBeenCalledWith(PANEL_ORIGIN, ["connect-src"], "SupportTemplates");
        h.native.isDomainAllowed.mockResolvedValue(true);
        expect(await h.ensure(true)).toBe("restart");
        expect(h.native.requestAddOverride).toHaveBeenCalledTimes(1);
    });
    it.each(["cancelled", "unchecked"])("does not proceed after %s", async result => {
        expect(await harness(false, result).ensure(true)).toBe("required");
    });
    it("does not prompt for an already permitted domain", async () => {
        const h = harness(true);
        expect(await h.ensure(true)).toBe("ready");
        expect(h.native.requestAddOverride).not.toHaveBeenCalled();
    });
    it("handles permission IPC failure without leaking its text", async () => {
        const h = harness();
        h.native.isDomainAllowed.mockRejectedValue(new Error("private details"));
        expect(await h.ensure(true)).toBe("unavailable");
        expect(h.native.requestAddOverride).not.toHaveBeenCalled();
    });
});
