export function copyToClipboard(text: string) {
    try { require("electron").clipboard.writeText(text); }
    catch { void navigator.clipboard.writeText(text).catch(() => {}); }
}
