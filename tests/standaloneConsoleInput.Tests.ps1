# Actual Windows console events, in a hidden private console; no SendKeys or user-window input.
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('SupportTemplates-console-input-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$dll = Join-Path $root 'probe.dll'
$driver = Join-Path $root 'driver.ps1'
$result = Join-Path $root 'result.json'
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'standalone/installer'
# Copy only presentation code; every operation uses this private fake backend.
Copy-Item -LiteralPath (Join-Path $source 'ConsoleInput.ps1') -Destination $root
Copy-Item -LiteralPath (Join-Path $source 'ConsoleView.ps1') -Destination $root
$helper = Join-Path $root 'ConsoleInput.ps1'
[IO.File]::WriteAllText((Join-Path $root 'PackageUpdate.ps1'), @'
param([switch]$Console,[switch]$CloseDiscord)
function Invoke-PackageUpdate($Operation,$Channel,$Cache,$Replacement) {
    [Threading.Thread]::Sleep(300)
    if ($Operation -eq 'Install') { throw 'fixture only' }
    return '{"action":"Update","selectedVersion":"7.8.9"}'
}
function Write-PackageConsoleResult($Status) { 'Verified fixture package' }
function Get-PackageConsoleError($Failure) { 'Fixture operation failed' }
'@, (New-Object Text.UTF8Encoding($true)))
Add-Type -OutputAssembly $dll -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ConsoleProbe {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct Startup {
        public int cb; public string reserved, desktop, title;
        public int x,y,xSize,ySize,xChars,yChars,fill,flags;
        public short show,reservedSize; public IntPtr reservedPtr,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process,thread; public uint pid,tid; }
    [StructLayout(LayoutKind.Explicit, Size=20)]
    public struct Input {
        [FieldOffset(0)] public ushort Type;
        [FieldOffset(4)] public int Down;
        [FieldOffset(8)] public ushort Repeat;
        [FieldOffset(10)] public ushort VirtualKey;
        [FieldOffset(14)] public char Character;
        [FieldOffset(16)] public uint State;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [StructLayout(LayoutKind.Sequential)] struct Coord { public short X,Y; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool ReadConsoleOutputCharacter(IntPtr handle, StringBuilder buffer, uint length, Coord at, out uint read);
    public static string Screen() {
        var result = new StringBuilder();
        for (int y=Console.WindowTop; y<Console.WindowTop+Console.WindowHeight; y++) {
            var row = new StringBuilder(Console.WindowWidth); uint read;
            if (!ReadConsoleOutputCharacter(GetStdHandle(-11), row, (uint)Console.WindowWidth,
                new Coord {X=(short)Console.WindowLeft,Y=(short)y}, out read))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            result.AppendLine(row.ToString().Substring(0, (int)read));
        }
        return result.ToString();
    }
    [DllImport("kernel32.dll")] static extern uint GetConsoleProcessList(uint[] ids, uint count);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("kernel32.dll", EntryPoint="WriteConsoleInputW", SetLastError=true)]
    static extern bool WriteInput(IntPtr handle, Input[] records, uint length, out uint written);
    public static uint Run(string app, string command, string cwd) {
        // New console, hidden from creation; no inherited handles and no AttachConsole.
        var startup = new Startup(); startup.cb=Marshal.SizeOf(startup); startup.flags=1; startup.show=0;
        ProcessInfo info;
        if (!CreateProcess(app, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,
            0x10, IntPtr.Zero, cwd, ref startup, out info))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {
            if (WaitForSingleObject(info.process, 45000) != 0) {
                TerminateProcess(info.process, 124);
                throw new Exception("Private ReadKey probe timed out after 45 seconds");
            }
            uint code;
            if (!GetExitCodeProcess(info.process, out code)) throw new Exception("No process result");
            return code;
        } finally { CloseHandle(info.thread); CloseHandle(info.process); }
    }
    public static void Queue() {
        uint[] ids = new uint[4];
        uint count = GetConsoleProcessList(ids, 4);
        if (count != 1 || ids[0] != (uint)System.Diagnostics.Process.GetCurrentProcess().Id ||
            Console.IsInputRedirected || IsWindowVisible(GetConsoleWindow()))
            throw new Exception("Refusing input injection: console must be hidden and private");
        // Shift itself has NUL KeyChar; Shift+1 is punctuation. Only final two events are choices.
        ushort[] keys = { 0x10, 0x31, 0x31, 0x31, 0x26, 0x0d, 0x58, 0x31, 0x60 };
        char[] chars = { '\0', '!', '1', '1', '\0', '\r', 'x', '1', '0' };
        uint[] states = { 0x10, 0x10, 0x2, 0x8, 0, 0, 0, 0, 0x10 };
        var events = new Input[keys.Length*2];
        for (int i=0; i<keys.Length; i++) {
            var item = new Input { Type=1, Down=1, Repeat=1, VirtualKey=keys[i], Character=chars[i], State=states[i] };
            events[i*2]=item; item.Down=0; events[i*2+1]=item;
        }
        uint written;
        if (!WriteInput(GetStdHandle(-10), events, (uint)events.Length, out written) || written != events.Length)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
}
"@
Add-Type -Path $dll
$driverText = @"
param([string]`$Helper,[string]`$Result,[string]`$Library)
`$ErrorActionPreference = 'Stop'
try {
    . `$Helper
    Add-Type -Path `$Library
    . (Join-Path (Split-Path `$Helper -Parent) 'ConsoleView.ps1')
    `$before = @{foreground=[Console]::ForegroundColor;background=[Console]::BackgroundColor;title=[Console]::Title;cursor=[Console]::CursorVisible;encoding=[Console]::OutputEncoding.CodePage}
    Initialize-ConsoleView
    `$originalMode = `$script:ConsoleView.Mode
    [ConsoleProbe]::Queue()
    `$wait = Invoke-ConsoleOperation 'Update' '' (Split-Path `$Helper -Parent) 'Checking package' 'Fixture operation'
    if (-not `$wait.Success) { throw 'Fake operation failed' }
    Show-ConsoleScreen 'Install' @(New-ConsoleLine 'Fixture package checked') '[1] Install    [0] Exit'
    `$screen = [ConsoleProbe]::Screen()
    if (-not `$screen.Contains('.--------.') -or -not `$screen.Contains('[1] Install')) { throw ('Incomplete console frame: ' + `$screen) }
    `$first = Read-MenuKey '10'
    `$second = Read-MenuKey '10'
    if (`$first -ne 1 -or `$second -ne 2) { throw "Wrong selections: `$first,`$second" }
    Restore-ConsoleView
    `$mode = [uint32]0
    if (-not [SupportTemplatesConsoleMode]::GetConsoleMode([SupportTemplatesConsoleMode]::GetStdHandle(-11),[ref]`$mode) -or `$mode -ne `$originalMode) { throw 'Console mode not restored' }
    if ([Console]::ForegroundColor -ne `$before.foreground -or [Console]::BackgroundColor -ne `$before.background -or [Console]::Title -cne `$before.title -or [Console]::CursorVisible -ne `$before.cursor -or [Console]::OutputEncoding.CodePage -ne `$before.encoding) { throw 'Console state not restored' }
    # Restoration after a failed fake operation uses the same finally path.
    try {
        Initialize-ConsoleView
        `$failed = Invoke-ConsoleOperation 'Install' 'PTB' (Split-Path `$Helper -Parent) 'Installing' 'Fixture failure'
        if (`$failed.Success) { throw 'Expected fake failure' }
    } finally { Restore-ConsoleView }
    if ([Console]::Title -cne `$before.title -or [Console]::CursorVisible -ne `$before.cursor -or [Console]::OutputEncoding.CodePage -ne `$before.encoding) { throw 'Console state not restored after failure' }
    @{ok=`$true;hidden=`$true;isolated=`$true;first=`$first;second=`$second;screen=`$screen;restored=`$true;typeAheadPreserved=`$true} | ConvertTo-Json | Set-Content -LiteralPath `$Result -Encoding UTF8
    exit 0
} catch {
    @{ok=`$false;error=[string]`$_} | ConvertTo-Json | Set-Content -LiteralPath `$Result -Encoding UTF8
    exit 1
}
"@
[IO.File]::WriteAllText($driver, $driverText, (New-Object Text.UTF8Encoding($true)))
$ps = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$command = '"' + $ps + '" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $driver + '" -Helper "' + $helper + '" -Result "' + $result + '" -Library "' + $dll + '"'
$code = [ConsoleProbe]::Run($ps, $command, $root)
if (-not (Test-Path -LiteralPath $result)) { throw "Probe returned $code without evidence: $root" }
$evidence = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
if ($code -ne 0 -or -not $evidence.ok) { throw (Get-Content -LiteralPath $result -Raw) }
# Selection/filtering is asserted; acoustic output and terminal visual rendering are not measured.
Write-Output 'PASS hidden private console: animated operation preserves queued digits; Shift/NUL, Shift+1, Alt/Ctrl digits, arrow, Enter, invalid letter ignored; ST frame and console restoration verified'
Write-Output "Evidence: $result"
