export const pins = Object.freeze({ 'monaco-editor': '0.57.0', dompurify: '3.4.17', esbuild: '0.28.2' });
export const csp = "default-src 'none'; script-src 'none'; worker-src blob:; style-src 'unsafe-inline'; font-src data:; img-src data: blob:; connect-src 'none'";

export function assertQuickCssHtml(html, script) {
    if (typeof script !== 'string') throw Error('Missing packaged QuickCSS script');
    const versions = [...script.matchAll(/DOMPurify (\d+\.\d+\.\d+)/g)].map(match => match[1]);
    if (!versions.length || versions.some(version => version !== pins.dompurify)) throw Error('Unexpected bundled DOMPurify version');
    const decoded = html.replaceAll('&apos;', "'");
    if (!decoded.includes(`content="${csp}"`)) throw Error('QuickCSS network policy missing or changed');
    if (/<script\b/i.test(html) || /<link\b[^>]*\bhref\s*=/i.test(html)) throw Error('QuickCSS assets must be bundled');
    if (/https:\/\/cdn\.jsdelivr\.net\/npm\/monaco-editor@/i.test(html + script)) throw Error('Legacy Monaco CDN remains');
    if (Buffer.byteLength('data:text/html;base64,' + Buffer.from(html).toString('base64')) > 2 * 1024 * 1024) throw Error('QuickCSS document exceeds Electron URL limit');
}
