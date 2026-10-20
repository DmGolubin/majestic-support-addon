import fs from 'node:fs';
import path from 'node:path';

// The console launchers are the only files beside the service directory.
export function copyInstaller(installerRoot, packageRoot) {
    const launchers = ['install.bat', 'uninstall.bat'];
    const helpers = ['SupportTemplates.ps1', 'RendererUpdate.ps1', 'PackageUpdate.ps1', 'ConsoleInput.ps1', 'Migration.ps1'];
    for (const name of [...launchers, ...helpers]) {
        if (!fs.statSync(path.join(installerRoot, name), { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing installer entry: ${name}`);
    }
    for (const name of [...launchers, ...helpers]) {
        const target = launchers.includes(name) ? path.dirname(packageRoot) : packageRoot;
        fs.copyFileSync(path.join(installerRoot, name), path.join(target, name));
    }
}
