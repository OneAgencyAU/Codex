# Installs and configures the Bet Overlay app on an Android TV / Google TV over adb.
# Windows PowerShell 5.1 or PowerShell 7.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\setup-tv.ps1 <TV_IP[:PORT]> <SERVER_URL>
#   e.g. powershell -ExecutionPolicy Bypass -File scripts\setup-tv.ps1 192.168.1.50 http://192.168.1.20:8787
#
# Before running: enable Developer options and USB debugging on the TV. On Android 14 Google TV
# you may need Wireless debugging: run "adb pair <ip>:<pair-port> <code>" once, then pass <ip>:<port>.

param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Target,
    [Parameter(Mandatory = $true, Position = 1)][string]$ServerUrl
)

$ErrorActionPreference = 'Continue'
$Pkg = 'au.home.betoverlay'
$ServiceFull = "$Pkg/$Pkg.OverlayService"
$ServiceShort = "$Pkg/.OverlayService"
$Tag = 'BetOverlay'
$Apk = Join-Path $PSScriptRoot '..\tv-app\dist\bet-overlay-debug.apk'
$script:Fails = 0

function Ok($m)   { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Fail($m) { Write-Host "[FAIL] $m" -ForegroundColor Red; $script:Fails++ }
function Note($m) { Write-Host "       $m" }
function Step($m) { Write-Host ""; Write-Host "== $m" }
function Die($m)  { Fail $m; Write-Host ""; Write-Host "Stopping: fix the problem above and run the script again."; exit 1 }

if ($Target -match ':') { $Serial = $Target } else { $Serial = "${Target}:5555" }
if ($ServerUrl -notmatch '^https?://') { $ServerUrl = "http://$ServerUrl" }

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    Write-Host "adb not found. Install Android platform-tools (winget install Google.PlatformTools) and add it to PATH."
    exit 1
}

# Runs adb against the TV and returns trimmed text output (stderr folded in).
function Adb {
    $out = & adb -s $Serial @args 2>&1 | ForEach-Object { "$_" }
    return (($out -join "`n") -replace "`r", '').Trim()
}
function Sh { return (Adb shell @args) }

# ---------------------------------------------------------------------------
Step "1. Connect to $Serial"
Note "If the TV shows an 'Allow debugging?' prompt, choose Always allow / OK."
& adb connect $Serial 2>&1 | Out-Null
$state = ''
for ($i = 0; $i -lt 60; $i++) {
    $state = ((& adb -s $Serial get-state 2>&1 | ForEach-Object { "$_" }) -join ' ').Trim()
    if ($state -eq 'device') { break }
    if ($state -match 'unauthorized') {
        if ($i % 10 -eq 0) { Note 'Waiting for you to accept the prompt on the TV...' }
    } elseif ($i % 10 -eq 5) {
        & adb connect $Serial 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 1
}
if ($state -eq 'device') {
    Ok "Connected to $Serial"
} else {
    Note "adb state: $state"
    Note 'Check the IP, that debugging is on, and that the prompt was accepted.'
    Note "Android 14: use Wireless debugging, run 'adb pair <ip>:<port> <code>', then pass <ip>:<port>."
    Die "Could not connect to $Serial"
}

# ---------------------------------------------------------------------------
Step '2. Device info'
Note ("manufacturer: " + (Sh getprop ro.product.manufacturer))
Note ("model:        " + (Sh getprop ro.product.model))
$sdk = Sh getprop ro.build.version.sdk
Note ("android:      " + (Sh getprop ro.build.version.release) + " (SDK $sdk)")
Note ("fingerprint:  " + (Sh getprop ro.build.fingerprint))
Note ((Sh wm size) -replace "`n", ' ')
Note ((Sh wm density) -replace "`n", ' ')
$sdkNum = 0
if ([int]::TryParse($sdk, [ref]$sdkNum)) {
    if ($sdkNum -lt 28) { Die "Android SDK $sdkNum is too old (needs 28+)" } else { Ok "SDK $sdkNum is supported" }
} else {
    Fail 'Could not read SDK level'
}

# ---------------------------------------------------------------------------
Step '3. Streaming apps installed'
$apps = (Sh pm list packages) -split "`n" | ForEach-Object { $_ -replace '^package:', '' } |
    Where-Object { $_ -match '(?i)kayo|nba|foxtel|sport' } | Sort-Object
if ($apps) {
    $apps | ForEach-Object { Note $_ }
    Ok 'Found matching packages'
} else {
    Note 'No packages matching kayo|nba|foxtel|sport (not a problem for the overlay).'
    Ok 'Package scan done'
}

# ---------------------------------------------------------------------------
Step "4. Install $Apk"
if (-not (Test-Path $Apk)) { Die "APK not found at $Apk (build it with: cd tv-app; .\gradlew.bat assembleDebug)" }
$out = Adb install -r (Resolve-Path $Apk).Path
if ($out -match 'Success') {
    Ok 'Installed'
} else {
    $out -split "`n" | ForEach-Object { Note $_ }
    if ($out -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE') {
        Note 'An older copy signed with a different key is installed. Remove it with:'
        Note "  adb -s $Serial uninstall $Pkg"
    }
    Die 'adb install failed'
}

# ---------------------------------------------------------------------------
Step '5. Enable the accessibility service'
$current = Sh settings get secure enabled_accessibility_services
if ($current -eq 'null' -or [string]::IsNullOrWhiteSpace($current)) { $current = '' }
$entries = @($current -split ':' | Where-Object { $_ -ne '' })
if ($entries -contains $ServiceFull -or $entries -contains $ServiceShort) {
    Ok 'Already in enabled_accessibility_services'
} else {
    $new = (@($entries) + $ServiceFull) -join ':'
    Sh "settings put secure enabled_accessibility_services '$new'" | Out-Null
    Ok 'Set enabled_accessibility_services'
    if ($current) { Note "kept existing: $current" }
}
Sh settings put secure accessibility_enabled 1 | Out-Null
if ((Sh settings get secure accessibility_enabled) -eq '1') { Ok 'accessibility_enabled = 1' } else { Fail 'accessibility_enabled is not 1' }

# ---------------------------------------------------------------------------
Step '6. Keep the app alive (TCL specific, failures are fine)'
& adb -s $Serial shell appops set $Pkg AUTO_START allow 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Ok 'appops AUTO_START allow'
} else {
    Note 'appops AUTO_START not supported on this firmware (fine; accessibility services restart anyway)'
}
if ((Sh dumpsys deviceidle whitelist "+$Pkg") -match '(?i)added') {
    Ok 'Added to deviceidle whitelist'
} else {
    Note 'deviceidle whitelist did not confirm (fine on most TVs)'
}

# ---------------------------------------------------------------------------
Step "7. Configure server URL: $ServerUrl"
$out = Sh "am start -n $Pkg/.SetupActivity --es server_url '$ServerUrl' --ez headless true"
if ($out -match '(?i)error') {
    $out -split "`n" | ForEach-Object { Note $_ }
    Fail 'am start failed'
} else {
    Ok 'Sent configuration'
}

# ---------------------------------------------------------------------------
Step '8. Verify'
Start-Sleep -Seconds 3
$now = Sh settings get secure enabled_accessibility_services
$nowEntries = @($now -split ':')
if ($nowEntries -contains $ServiceFull -or $nowEntries -contains $ServiceShort) {
    Ok 'Service listed in enabled_accessibility_services'
} else {
    Fail "Service missing from enabled_accessibility_services: $now"
}
$dump = Sh dumpsys accessibility
$bound = ($dump -split "`n" | Where-Object { $_ -match '(?i)bound services' }) -join ' '
if ($bound -match [regex]::Escape($Pkg) -or $bound -match 'Bet Overlay panel') {
    Ok 'Service is bound (dumpsys accessibility)'
} elseif ($dump -match [regex]::Escape($Pkg)) {
    Ok "dumpsys accessibility lists $Pkg (bound state not shown on this firmware)"
} else {
    Fail "Service not bound yet. Open Settings > Accessibility on the TV and turn on 'Bet Overlay panel'."
}
Note "Last $Tag log lines:"
((Adb logcat -d -s $Tag) -split "`n" | Select-Object -Last 20) | ForEach-Object { Note $_ }

Write-Host ''
if ($script:Fails -eq 0) {
    Write-Host 'All steps OK. The panel should be in the top right corner of the TV.'
} else {
    Write-Host "$($script:Fails) step(s) failed; see [FAIL] lines above."
}
Write-Host "Next: run 'adb -s $Serial logcat -s BetOverlay' and press remote buttons to find their key codes,"
Write-Host 'then set them with:'
Write-Host "  adb -s $Serial shell am start -n $Pkg/.SetupActivity --ei toggle_key <code> --ei cycle_key <code> --ez headless true"
if ($script:Fails -eq 0) { exit 0 } else { exit 1 }
