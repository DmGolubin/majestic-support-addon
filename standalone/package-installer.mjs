import fs from 'node:fs';
import path from 'node:path';

// Used from the frozen build snapshot; the existing root CLI/update contract stays intact.
export function copyInstaller(installerRoot, packageRoot) {
    for (const name of ['SupportTemplates.ps1', 'RendererUpdate.ps1', 'install.bat',
        'SupportTemplates.Gui.ps1', 'InstallerGui.psm1', 'InstallerGui.xaml']) {
        if (!fs.statSync(path.join(installerRoot, name)).isFile()) throw new Error(`Missing installer entry: ${name}`);
    }
    for (const entry of fs.readdirSync(installerRoot))
        fs.cpSync(path.join(installerRoot, entry), path.join(packageRoot, entry), { recursive: true });
}
