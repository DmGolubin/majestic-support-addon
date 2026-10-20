import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const code = ts.transpileModule(readFileSync(new URL("../src/vencord/ui/DiagnosticControls.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
}).outputText;
const text = (n: any): string => Array.isArray(n) ? n.map(text).join("") : n == null || typeof n === "boolean" ? ""
    : typeof n === "object" ? text(n.props?.children) : String(n);
const nodes = (n: any): any[] => Array.isArray(n) ? n.flatMap(nodes) : !n || typeof n !== "object" ? [] : [n, ...nodes(n.props?.children)];
function fixture(overrides = {}) {
    const file = Object.freeze({ path: "C:\\Users\\Тест\\SupportTemplates\\diagnostics\\main.log",
        initializing: false, fileError: false, localError: false, deliveryLost: 5, lastSavedAt: 1, ...overrides });
    const journal = { active: true };
    const open = vi.fn(async () => {}), retry = vi.fn();
    const setRecording = vi.fn((active: boolean) => { journal.active = active; });
    let cursor = 0; const slots: any[] = [];
    const deps: Record<string, any> = {
        "@webpack/common": { useEffect() {}, useState(value: any) {
            const i = cursor++;
            if (!(i in slots)) slots[i] = value;
            return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }];
        } },
        "../core/diagnosticJournal": { diagnosticJournal: journal },
        "./diagnostics": { diagnosticStorageStatus: () => file, openDiagnosticFolder: open, retryDiagnosticFile: retry, setRecording },
        "./diagnostics.css": {}
    };
    const exports: any = {};
    runInNewContext(code, { exports, React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) },
        require: (id: string) => { if (!(id in deps)) throw Error(id); return deps[id]; } });
    const render = (available = true) => { cursor = 0; return exports.DiagnosticControls({ available }); };
    const button = (label: string) => nodes(render()).find(n => n.type === "button" && text(n) === label);
    return { file, render, button, open, retry, setRecording };
}

describe("diagnostics settings controls", () => {
    it("shows the exact log path without historical-loss warnings or mutating loss state", () => {
        const h = fixture(), tree = h.render();
        expect(text(nodes(tree).find(n => n.type === "code"))).toBe(h.file.path);
        expect(nodes(tree).filter(n => n.props.role === "alert")).toHaveLength(0);
        expect(text(tree)).not.toContain("Технические события");
        expect(text(tree)).not.toContain("неподтверждённые события");
        expect(h.file.deliveryLost).toBe(5);
        expect(h.setRecording).not.toHaveBeenCalled();
        expect(h.retry).not.toHaveBeenCalled();
        expect(h.open).not.toHaveBeenCalled();
    });
    it.each([true, false])("does not invent a path while initializing=%s", initializing => {
        const tree = fixture({ path: "", initializing }).render();
        expect(text(tree)).toContain(initializing ? "Определяем путь…" : "Путь к логам пока недоступен");
        expect(nodes(tree).some(n => n.type === "code")).toBe(false);
        expect(nodes(tree).find(n => n.type === "input").props.disabled).toBe(initializing);
    });
    it("retains the recording toggle and unavailable-host guard", () => {
        const h = fixture();
        const input = () => nodes(h.render()).find(n => n.type === "input");
        expect(input().props.checked).toBe(true);
        input().props.onChange({ currentTarget: { checked: false } });
        expect(input().props.checked).toBe(false);
        expect(h.setRecording).toHaveBeenCalledExactlyOnceWith(false);
        expect(nodes(h.render(false)).find(n => n.type === "input").props.disabled).toBe(true);
        expect(h.file.deliveryLost).toBe(5);
    });
    it.each([
        [true, false, "Не удалось сохранить логи."],
        [true, true, "Не удалось сохранить логи и резервную копию."],
        [false, true, "Резервная копия логов недоступна."]
    ])("retains concise current errors file=%s local=%s", (fileError, localError, message) => {
        const h = fixture({ fileError, localError });
        expect(nodes(h.render()).filter(n => n.props.role === "alert").map(text)).toEqual([message]);
        if (fileError) {
            h.button("Повторить сохранение").props.onClick();
            expect(h.retry).toHaveBeenCalledExactlyOnceWith();
        }
        expect(h.file.deliveryLost).toBe(5);
    });
    it("opens only on click, displays failures, and clears them on a successful retry", async () => {
        const h = fixture();
        h.open.mockRejectedValueOnce(Error("private native details"));
        const pending = h.button("Открыть папку логов").props.onClick();
        expect(h.button("Открываем…").props.disabled).toBe(true);
        await pending;
        expect(text(h.render())).toContain("Не удалось открыть папку логов. Повторите попытку.");
        expect(text(h.render())).not.toContain("private native details");
        await h.button("Открыть папку логов").props.onClick();
        expect(nodes(h.render()).filter(n => n.props.role === "alert")).toHaveLength(0);
        expect(h.open.mock.calls).toEqual([[], []]);
        expect(h.file.deliveryLost).toBe(5);
    });
});
