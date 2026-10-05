import { readFileSync } from "node:fs";
import { importBackup } from "./src/core/importer";
import { titleKey } from "./src/core/text";

const all = importBackup(readFileSync("./tests/fixtures/config-0.5.1.json", "utf8")).templates;

function findMirror(t: any, pool: any[], project: string) {
    if (!t.project || t.project === project) return null;
    const k = titleKey(t.title);
    return pool.find(x => x.project === project && titleKey(x.title) === k) ?? null;
}

const ro = all.filter(t => t.project === "ro");
const mirrored = ro.filter(t => findMirror(t, all, "mj"));
const unmirrored = ro.filter(t => !findMirror(t, all, "mj"));

console.log(`Total RO templates: ${ro.length}`);
console.log(`Mirrored: ${mirrored.length}`);
console.log(`Unmirrored: ${unmirrored.length}`);
console.log(`Mirror ratio: ${(mirrored.length / ro.length).toFixed(4)}`);
console.log(`Passes 0.8 threshold: ${(mirrored.length / ro.length) > 0.8 ? 'YES' : 'NO'}`);
console.log('\nUnmirrored titles:');
unmirrored.forEach(t => console.log(`  - ${t.title}`));
