// Minimal flat ASAR writer for the two-file bootstrap, no external packer at install time.
// Format reference: https://github.com/electron/asar/blob/main/src/disk.ts
export function createLoaderAsar(files) {
    const header = { files: {} }, chunks = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
        if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Invalid flat ASAR name');
        const bytes = Buffer.from(content);
        header.files[name] = { size: bytes.length, offset: String(offset) };
        chunks.push(bytes); offset += bytes.length;
    }
    const json = Buffer.from(JSON.stringify(header));
    const pickle = Buffer.alloc(4 + Math.ceil((4 + json.length) / 4) * 4);
    pickle.writeUInt32LE(pickle.length - 4, 0);
    pickle.writeUInt32LE(json.length, 4);
    json.copy(pickle, 8);
    const size = Buffer.alloc(8);
    size.writeUInt32LE(4, 0); size.writeUInt32LE(pickle.length, 4);
    return Buffer.concat([size, pickle, ...chunks]);
}
