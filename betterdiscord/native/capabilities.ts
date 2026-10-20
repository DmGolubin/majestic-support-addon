// SPDX-License-Identifier: GPL-3.0-or-later
import * as fs from "fs";
import * as crypto from "crypto";

/** Standard BD exposes filesystem/crypto polyfills, not the native Node surface.
 * Test supported modules first; never probe unsupported names through its file loader.
 * Do not weaken atomic writes, process locks or encrypted storage to emulate Node.
 */
export function hasNativeStorage(): boolean {
    return ["openSync", "readSync", "writeSync", "fsyncSync", "closeSync", "linkSync", "lstatSync"]
        .every(name => typeof (fs as any)[name] === "function")
        && !!fs.constants && typeof fs.promises?.open === "function"
        && typeof crypto.randomUUID === "function" && typeof process.kill === "function";
}
