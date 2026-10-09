# Run the APK on a real Android WebView at 1280x720 landscape, headless.
#
# Everything is derived from this script's own location and the environment --
# no absolute paths baked in, so a fresh clone works for anyone.
#   Windows:  .\tools\run-on-emulator.ps1
#   Overrides: -SdkDir <path>  -AvdName <name>  -OutDir <path>
#
# Requires: JDK 17 (JAVA_HOME), Android SDK with emulator + a system image,
#           and an AVD. Create one with:
#             sdkmanager "emulator" "system-images;android-34;google_apis;x86_64"
#             avdmanager create avd -n pbs720 -k "system-images;android-34;google_apis;x86_64"
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI, so UTF-8
# non-ASCII comments would turn into mojibake and break quoting.
param(
    [string]$SdkDir  = '',
    [string]$AvdName = 'pbs720',
    [string]$OutDir  = ''
)

$ErrorActionPreference = 'Continue'

$AppRoot = Split-Path -Parent $PSScriptRoot          # .../pixel-bead-app
if (-not $OutDir) { $OutDir = Join-Path $AppRoot 'build\verify-shots' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ---- locate the Android SDK: param > env > local.properties > common spots ----
if (-not $SdkDir) {
    if ($env:ANDROID_HOME)      { $SdkDir = $env:ANDROID_HOME }
    elseif ($env:ANDROID_SDK_ROOT) { $SdkDir = $env:ANDROID_SDK_ROOT }
}
if (-not $SdkDir) {
    $lp = Join-Path $AppRoot 'local.properties'
    if (Test-Path $lp) {
        $line = Get-Content $lp | Where-Object { $_ -match '^\s*sdk\.dir\s*=' } | Select-Object -First 1
        if ($line) { $SdkDir = ($line -replace '^\s*sdk\.dir\s*=\s*', '').Trim() -replace '\\\\', '\' }
    }
}
if (-not $SdkDir -or -not (Test-Path $SdkDir)) {
    Write-Host "!! Android SDK not found."
    Write-Host "   Set ANDROID_HOME, or create local.properties with:  sdk.dir=/path/to/sdk"
    Write-Host "   or pass -SdkDir <path>"
    exit 1
}
$SdkDir = (Resolve-Path $SdkDir).Path
$env:ANDROID_HOME = $SdkDir
$env:ANDROID_SDK_ROOT = $SdkDir

$adb = Join-Path $SdkDir 'platform-tools\adb.exe'
$emu = Join-Path $SdkDir 'emulator\emulator.exe'
$apk = Join-Path $AppRoot 'app\build\outputs\apk\debug\app-debug.apk'
$avdHome = Join-Path $env:USERPROFILE '.android\avd'

foreach ($tool in @($adb, $emu)) {
    if (-not (Test-Path $tool)) {
        Write-Host "!! missing: $tool"
        Write-Host "   sdkmanager `"platform-tools`" `"emulator`""
        exit 1
    }
}
if (-not (Test-Path $apk)) {
    Write-Host "!! missing APK: $apk"
    Write-Host "   build it first:  .\gradlew assembleDebug"
    exit 1
}

Write-Host "SDK      : $SdkDir"
Write-Host "APK      : $apk"
Write-Host "shots    : $OutDir"
if ($env:JAVA_HOME) { Write-Host "JAVA_HOME: $env:JAVA_HOME" } else { Write-Host "JAVA_HOME: (not set - gradle needs it)" }

# ---- 1. pin the AVD to 1280x720 landscape ----
$cfg = Join-Path $avdHome "$AvdName.avd\config.ini"
if (-not (Test-Path $cfg)) {
    Write-Host "!! AVD '$AvdName' not found at $cfg"
    Write-Host "   avdmanager create avd -n $AvdName -k `"system-images;android-34;google_apis;x86_64`""
    exit 1
}
$lines = Get-Content $cfg | Where-Object { $_ -notmatch '^hw\.lcd\.|^hw\.initialOrientation|^skin\.|^hw\.keyboard|^hw\.ramSize|^disk\.dataPartition' }
$lines += 'hw.lcd.width=1280'
$lines += 'hw.lcd.height=720'
$lines += 'hw.lcd.density=160'
$lines += 'hw.initialOrientation=landscape'
$lines += 'hw.keyboard=yes'
$lines += 'hw.ramSize=4096'
$lines += 'disk.dataPartition.size=4096M'
$lines | Set-Content $cfg -Encoding ASCII
Write-Host "AVD '$AvdName' pinned to 1280x720 landscape"

& $adb kill-server  | Out-Null
& $adb start-server | Out-Null

# ---- 2. boot the emulator headless ----
Write-Host "starting emulator ..."
$emuArgs = @('-avd', $AvdName, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot',
             '-gpu', 'swiftshader_indirect', '-memory', '3072')
$emuProc = Start-Process -FilePath $emu -ArgumentList $emuArgs -PassThru `
    -RedirectStandardOutput (Join-Path $OutDir 'emu-out.log') `
    -RedirectStandardError  (Join-Path $OutDir 'emu-err.log')

# ---- 3. wait for boot ----
Write-Host "waiting for boot_completed ..."
$booted = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 5
    $b = (& $adb shell getprop sys.boot_completed 2>$null) -join ''
    if ($b.Trim() -eq '1') { $booted = $true; break }
    if ($emuProc.HasExited) { Write-Host "emulator exited: $($emuProc.ExitCode)"; break }
}
if (-not $booted) {
    Write-Host "!! emulator did not boot; tail of stderr:"
    Get-Content (Join-Path $OutDir 'emu-err.log') -Tail 40 -ErrorAction SilentlyContinue
    exit 2
}
Write-Host "booted."
& $adb shell getprop ro.build.version.release
& $adb shell getprop ro.build.version.sdk
& $adb shell wm size
& $adb shell wm density

# ---- 4. install + launch ----
Write-Host "installing APK ..."
& $adb install -r -t $apk 2>&1 | Select-Object -Last 3

& $adb logcat -c
& $adb shell am start -n com.byd.pixelbead/.MainActivity 2>&1 | Select-Object -Last 2
Start-Sleep -Seconds 15

# ---- 5. screenshot + logs ----
& $adb shell screencap -p /sdcard/pbs-boot.png
& $adb pull /sdcard/pbs-boot.png (Join-Path $OutDir 'emulator-boot.png') 2>&1 | Select-Object -Last 1

Write-Host ""
Write-Host "=== logcat (PixelBead / PBSBridge) ==="
& $adb logcat -d -s PixelBead:V PixelBead.E:V PBSBridge:V 2>&1 | Select-Object -Last 40

# ---- 6. draw on the canvas ----
Write-Host ""
Write-Host "=== swipe on canvas (should paint, not scroll) ==="
& $adb shell input swipe 480 300 800 480 500
Start-Sleep -Seconds 2
& $adb shell screencap -p /sdcard/pbs-draw.png
& $adb pull /sdcard/pbs-draw.png (Join-Path $OutDir 'emulator-draw.png') 2>&1 | Select-Object -Last 1

Write-Host ""
Write-Host "=== tap top-right (send to screen) ==="
& $adb shell input tap 1210 26
Start-Sleep -Seconds 3
& $adb shell screencap -p /sdcard/pbs-send.png
& $adb pull /sdcard/pbs-send.png (Join-Path $OutDir 'emulator-send.png') 2>&1 | Select-Object -Last 1
& $adb logcat -d -s PBSBridge:V PixelBead:V 2>&1 | Select-Object -Last 30

Write-Host ""
Write-Host "=== /sdcard/Download/PixelBead ==="
& $adb shell ls -la /sdcard/Download/PixelBead/

Write-Host ""
Write-Host "screenshots in $OutDir"
Write-Host "emulator still running; stop with: adb emu kill"
