// GPL-3.0-or-later. Deterministic store-only ZIP and USTAR for local release artifacts.
import fs from 'node:fs';
import path from 'node:path';
import { files } from './runtime/package.cjs';
const crcTable = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
});
function crc32(bytes) { let n = 0xffffffff; for (const b of bytes) n = crcTable[(n ^ b) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0; }
export function writeZip(root, output, prefix = path.basename(root)) {
    const local = [], central = []; let offset = 0;
    for (const file of files(root)) {
        const bytes = fs.readFileSync(file), name = Buffer.from(prefix + '/' + path.relative(root, file).replaceAll('\\', '/'));
        const crc = crc32(bytes), head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6);
        head.writeUInt16LE(33, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(bytes.length, 18); head.writeUInt32LE(bytes.length, 22); head.writeUInt16LE(name.length, 26);
        const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8);
        c.writeUInt16LE(33, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(bytes.length, 20); c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
        local.push(head, name, bytes); central.push(c, name); offset += head.length + name.length + bytes.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    fs.writeFileSync(output, Buffer.concat([...local, directory, end]));
}
export function writeTar(root, output, { exclude = ['node_modules', 'dist'], epoch = 0 } = {}) {
    const chunks = [];
    // Avoid entering dependency junctions; files() deliberately rejects redirects.
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name < b.name ? -1 : 1).flatMap(entry => {
        const file = path.join(dir, entry.name), name = path.relative(root, file).replaceAll('\\', '/');
        if (exclude.includes(name)) return [];
        if (entry.isSymbolicLink()) throw Error('Source symlink refused: ' + name);
        return entry.isDirectory() ? walk(file) : [file];
    });
    for (const file of walk(root)) {
        let name = path.relative(root, file).replaceAll('\\', '/'), prefix = '';
        if (Buffer.byteLength(name) > 100) {
            const split = name.lastIndexOf('/'); prefix = name.slice(0, split); name = name.slice(split + 1);
        }
        if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw Error('USTAR path too long');
        const bytes = fs.readFileSync(file), header = Buffer.alloc(512);
        const octal = (n, at, len) => header.write(n.toString(8).padStart(len - 1, '0') + '\0', at, len, 'ascii');
        header.write(name); octal(0o644, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(bytes.length, 124, 12); octal(epoch, 136, 12);
        header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263); header.write(prefix, 345);
        const sum = header.reduce((a,b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
        chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    fs.writeFileSync(output, Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
