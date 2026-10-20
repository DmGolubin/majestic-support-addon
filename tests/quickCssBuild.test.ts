import { describe, expect, it } from "vitest";
import { assertQuickCssHtml } from "../distribution/quickcss/security.mjs";

const header = '<meta http-equiv="Content-Security-Policy" content="default-src &apos;none&apos;; script-src &apos;none&apos;; worker-src blob:; style-src &apos;unsafe-inline&apos;; font-src data:; img-src data: blob:; connect-src &apos;none&apos;">';
const script = '/*! DOMPurify 3.4.17 */';

describe("packaged QuickCSS security boundary", () => {
    it("rejects the previous CDN editor even when loader has SRI", () => {
        expect(() => assertQuickCssHtml(header + '<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.50.0/min/vs/loader.js" integrity="sha256-test"></script>', script)).toThrow(/must be bundled/);
    });
    it("rejects stale or multiple bundled DOMPurify versions", () => {
        expect(() => assertQuickCssHtml(header, script + '/*! DOMPurify 3.0.5 */')).toThrow();
        expect(() => assertQuickCssHtml(header, script.replace('3.4.17', '3.4.15'))).toThrow();
    });
    it("requires network-denying CSP and bundled scripts/styles", () => {
        expect(() => assertQuickCssHtml(header, script)).not.toThrow();
        expect(() => assertQuickCssHtml(header.replace('connect-src &apos;none&apos;', 'connect-src https:'), script)).toThrow();
        expect(() => assertQuickCssHtml(header + '<link rel="stylesheet" href="https://example.test/x.css">', script)).toThrow();
        expect(() => assertQuickCssHtml(header + '<script src="https://example.test/x.js"></script>', script)).toThrow();
        expect(() => assertQuickCssHtml(header + '<script>attack()</script>', script)).toThrow();
    });
    it("rejects a data URL too large for Electron before packaging", () => {
        expect(() => assertQuickCssHtml(header + ' '.repeat(1600000), script)).toThrow(/URL limit/);
    });
});
