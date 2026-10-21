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
    public static void Queue(ushort[] keys, char[] chars, uint[] states) {
        uint[] ids = new uint[4];
        uint count = GetConsoleProcessList(ids, 4);
        if (count != 1 || ids[0] != (uint)System.Diagnostics.Process.GetCurrentProcess().Id ||
            Console.IsInputRedirected || IsWindowVisible(GetConsoleWindow()))
            throw new Exception("Refusing input injection: console must be hidden and private");
        var events = new Input[keys.Length*2];
        for (int i=0; i<keys.Length; i++) {
            var item = new Input { Type=1, Down=1, Repeat=1, VirtualKey=keys[i], Character=chars[i], State=states[i] };
            events[i*2]=item; item.Down=0; events[i*2+1]=item;
        }
        uint written;
        if (!WriteInput(GetStdHandle(-10), events, (uint)events.Length, out written) || written != events.Length)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    public static void Queue() {
        // Selection must end on keypad 3. Modified Enter/Esc/0 must never act.
        Queue(
            new ushort[] { 0x10,0x31,0x31,0x31,0x32,0x26,0x25,0x27,0x28,0x63,0x0d,0x0d,0x0d,0x1b,0x1b,0x1b,0x30,0x30,0x30,0x22,0x21,0x24,0x09,0x08,0x58 },
            new char[] { '\0','!','1','1','2','\0','\0','\0','\0','3','\r','\r','\r','\x1b','\x1b','\x1b','0','0','0','\0','\0','\0','\t','\b','x' },
            new uint[] { 0x10,0x10,0x2,0x8,0,0,0,0,0,0,0x10,0x2,0x8,0x10,0x2,0x8,0x10,0x2,0x8,0,0,0,0,0,0 });
    }
    static System.Threading.Thread confirmer;
    public static string SelectedScreen;
    public static string ConfirmationError;
    public static void ConfirmLater() {
        confirmer = new System.Threading.Thread(() => {
            try {
                System.Threading.Thread.Sleep(500);
                SelectedScreen = Screen();
                Queue(new ushort[] { 0x0d }, new char[] { '\r' }, new uint[] { 0 });
            } catch (Exception error) { ConfirmationError = error.ToString(); }
        });
        confirmer.IsBackground = true;
        confirmer.Start();
    }
    public static void FinishConfirmation() { confirmer.Join(); }
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
    Show-ConsoleScreen 'Checking updates' @(New-ConsoleLine 'Installer version: 7.8.9' 'Muted') -Busy
    `$busyScreen = [ConsoleProbe]::Screen()
    if (`$busyScreen -notmatch '[\u2800-\u28ff]{2}' -or -not `$busyScreen.Contains('Installer version: 7.8.9')) { throw 'Dots14 or version missing from the native console buffer' }
    if ([Console]::BackgroundColor -ne [ConsoleColor]::Black) { throw 'Expected black installer background' }
    [ConsoleProbe]::Queue()
    `$wait = Invoke-ConsoleOperation 'Update' '' (Split-Path `$Helper -Parent) 'Checking package' 'Fixture operation'
    if (-not `$wait.Success) { throw 'Fake operation failed' }
    Show-ConsoleScreen 'Install' @(
        New-ConsoleLine '[1] Discord' 'Text' 'Left' '1'
        New-ConsoleLine '[2] Discord Canary' 'Text' 'Left' '2'
        New-ConsoleLine '[3] Discord PTB' 'Text' 'Left' '3'
    ) '[Enter] Install    [0 / Esc] Exit'
    `$screen = [ConsoleProbe]::Screen()
    if (-not `$screen.Contains('.--------.') -or -not `$screen.Contains('[1] Discord  < выбран >')) { throw ('Incomplete console frame: ' + `$screen) }
    `$timer = [Diagnostics.Stopwatch]::StartNew()
    [ConsoleProbe]::ConfirmLater()
    `$first = Read-MenuKey '1230'
    `$elapsed = `$timer.ElapsedMilliseconds
    [ConsoleProbe]::FinishConfirmation()
    if ([ConsoleProbe]::ConfirmationError) { throw [ConsoleProbe]::ConfirmationError }
    `$selectedScreen = [ConsoleProbe]::SelectedScreen
    if (`$first -ne 3 -or `$elapsed -lt 400 -or -not `$selectedScreen.Contains('[3] Discord PTB  < выбран >')) { throw "Selection acted before Enter or highlighted the wrong choice: `$first / `$elapsed / `$selectedScreen" }
    [ConsoleProbe]::Queue([uint16[]]@(0x60), [char[]]@('0'), [uint32[]]@(0))
    `$second = Read-MenuKey '1230'
    [ConsoleProbe]::Queue([uint16[]]@(0x1b), [char[]]@([char]27), [uint32[]]@(0))
    `$escape = Read-MenuKey '1230'
    if (`$second -ne 4 -or `$escape -ne 4) { throw "Cancel required Enter: `$second,`$escape" }
    [ConsoleProbe]::Queue([uint16[]]@(0x61,0x0d), [char[]]@('1', [char]13), [uint32[]]@(0,0))
    if ((Read-MenuKey '1230') -ne 1) { throw 'Keypad selection plus Enter failed' }
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
    @{ok=`$true;hidden=`$true;isolated=`$true;first=`$first;second=`$second;escape=`$escape;waitedForEnterMs=`$elapsed;screen=`$screen;selectedScreen=`$selectedScreen;busyScreen=`$busyScreen;restored=`$true;typeAheadPreserved=`$true} | ConvertTo-Json | Set-Content -LiteralPath `$Result -Encoding UTF8
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
Write-Output 'PASS hidden private console: numbers/keypad/arrows highlight until delayed Enter; modified Enter/Esc/digits and unsupported controls ignored; 0/Esc cancel; runspace type-ahead, ST frame and console restoration verified'
Write-Output "Evidence: $result"
