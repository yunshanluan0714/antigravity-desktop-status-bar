param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$src = (Resolve-Path (Join-Path $PSScriptRoot '..\wrapper')).Path
$homeDir = Join-Path $env:LOCALAPPDATA 'AntigravityStatusBar'
$launcher = Join-Path $homeDir 'launch.vbs'
$app = Join-Path $env:LOCALAPPDATA 'Programs\Antigravity\Antigravity.exe'
$hostExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
$argsLine = '"' + $launcher + '"'
$desktop = [Environment]::GetFolderPath('DesktopDirectory')
$links = @($desktop, [Environment]::GetFolderPath('Programs')) | ForEach-Object {
    Join-Path $_ 'Antigravity.lnk'
} | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
$shell = New-Object -ComObject WScript.Shell

function Test-ManagedShortcut($shortcut) {
    ($shortcut.TargetPath -ieq $hostExe) -and ($shortcut.Arguments -ieq $argsLine)
}

if ($Remove) {
    foreach ($link in $links) {
        $short = $shell.CreateShortcut($link)
        if (-not (Test-ManagedShortcut $short)) { continue }
        $backup = "$link.statusbar-original"
        if (!(Test-Path -LiteralPath $backup -PathType Leaf)) { throw "Missing original shortcut: $backup" }
        Copy-Item -LiteralPath $backup -Destination $link -Force
        if ($shell.CreateShortcut($link).TargetPath -ine $app) { throw "Could not verify restored shortcut: $link" }
        Write-Output "Restored: $link"
    }
    return
}

if (!(Test-Path -LiteralPath $app -PathType Leaf)) { throw "Antigravity.exe not found: $app" }
if (!$links) { throw 'No existing Antigravity shortcuts found.' }
foreach ($link in $links) {
    $short = $shell.CreateShortcut($link)
    if (-not (Test-ManagedShortcut $short) -and ($short.TargetPath -ine $app -or $short.Arguments)) {
        throw "Unexpected shortcut target or arguments; no shortcuts changed: $link"
    }
}
New-Item -ItemType Directory -Path $homeDir -Force | Out-Null
foreach ($file in @('launch.vbs', 'watcher.js', 'hook.cjs', 'statusbar.js', 'renderer.js', 'lib')) {
    Copy-Item -LiteralPath (Join-Path $src $file) -Destination $homeDir -Recurse -Force
}
foreach ($link in $links) {
    $short = $shell.CreateShortcut($link)
    if (-not (Test-ManagedShortcut $short)) {
        Copy-Item -LiteralPath $link -Destination "$link.statusbar-original" -Force
        $short.TargetPath = $hostExe
        $short.Arguments = $argsLine
        $short.IconLocation = "$app,0"
        $short.Save()
    }
    if (-not (Test-ManagedShortcut ($shell.CreateShortcut($link)))) { throw "Could not verify shortcut: $link" }
    Write-Output "Antigravity shortcut enables the status bar: $link"
}

$old = Join-Path $desktop 'Antigravity (Status Bar).lnk'
if (Test-Path -LiteralPath $old -PathType Leaf) {
    $short = $shell.CreateShortcut($old)
    $oldArgs = '"' + (Join-Path $src 'launch.vbs') + '"'
    if ($short.TargetPath -ieq $hostExe -and $short.Arguments -ieq $oldArgs) {
        Remove-Item -LiteralPath $old
    }
}
