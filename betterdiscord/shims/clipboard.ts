export async function copyToClipboard(text: string) {
    try { await require("electron").clipboard.writeText(text); }
    catch { await navigator.clipboard.writeText(text); }
}
