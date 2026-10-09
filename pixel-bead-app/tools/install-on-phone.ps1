# Install the APK on a physical phone through the PackageInstaller session API.
# Needed on MIUI/HyperOS where plain `adb install` is blocked by
# INSTALL_FAILED_USER_RESTRICTED ("Install via USB" off).
# Also tolerates a flaky USB link by retrying.
# ASCII only (Windows PowerShell 5.1 reads .ps1 as ANSI).
param(
    [string]$Apk     = '',
    [int]   $Retries = 5
)
$ErrorActionPreference = 'Continue'
$AppRoot = Split-Path -Parent $PSScriptRoot
if (-not $Apk) { $Apk = Join-Path $AppRoot 'prebuilt\pixelbead-debug.apk' }

$Sdk = $env:ANDROID_HOME
if (-not $Sdk) { $Sdk = $env:ANDROID_SDK_ROOT }
if (-not $Sdk) {
    $lp = Join-Path $AppRoot 'local.properties'
    if (Test-Path $lp) {
        # -Encoding UTF8 是必须的：PS 5.1 默认按 ANSI 读，汉字注释的最后一个字节
        # 会被当成 GBK 前导字节、把行尾换行一起吃掉，于是注释和 sdk.dir 粘成一行，
        # 下面这个正则就永远匹配不上。
        $line = Get-Content $lp -Encoding UTF8 | Where-Object { $_ -match '^\s*sdk\.dir\s*=' } | Select-Object -First 1
        if ($line) { $Sdk = ($line -replace '^\s*sdk\.dir\s*=\s*', '').Trim() }
    }
}
if (-not $Sdk) {
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { $Sdk = Split-Path -Parent (Split-Path -Parent $cmd.Source) }
}
if (-not $Sdk) { Write-Host '!! set ANDROID_HOME, or put sdk.dir in local.properties'; exit 1 }
$adb = Join-Path $Sdk 'platform-tools\adb.exe'

if (-not (Test-Path $Apk)) { Write-Host "!! missing APK: $Apk"; exit 1 }
$size = (Get-Item $Apk).Length
Write-Host "APK   : $Apk"
Write-Host "bytes : $size"

function Sh($cmd) { return ((& $adb shell $cmd 2>&1 | Out-String).Trim()) }

for ($attempt = 1; $attempt -le $Retries; $attempt++) {
    Write-Host ""
    Write-Host "--- attempt $attempt/$Retries ---"

    & $adb kill-server 2>&1 | Out-Null
    Start-Sleep -Milliseconds 500
    & $adb start-server 2>&1 | Out-Null
    Start-Sleep -Seconds 2

    $devices = ((& $adb devices 2>&1 | Out-String))
    if ($devices -notmatch '\bdevice\b' -or $devices -match 'no devices') {
        Write-Host "  no device; waiting 6s ..."
        Start-Sleep -Seconds 6
        continue
    }
    Write-Host "  device present"

    $before = Sh "dumpsys package com.byd.pixelbead | grep lastUpdateTime"
    Write-Host "  before: $before"

    & $adb push $Apk /data/local/tmp/pb.apk 2>&1 | Out-Null
    Sh "chmod 644 /data/local/tmp/pb.apk" | Out-Null

    $create = Sh "pm install-create -r -t -S $size"
    Write-Host "  create: $create"
    $sid = ([regex]::Match($create, '\[(\d+)\]')).Groups[1].Value
    if (-not $sid) { Write-Host "  no session id; retrying"; Start-Sleep -Seconds 4; continue }

    $w = Sh "pm install-write -S $size $sid base /data/local/tmp/pb.apk"
    Write-Host "  write : $w"
    $c = Sh "pm install-commit $sid"
    Write-Host "  commit: $c"

    Sh "rm -f /data/local/tmp/pb.apk" | Out-Null

    if ($c -match 'Success') {
        $after = Sh "dumpsys package com.byd.pixelbead | grep lastUpdateTime"
        Write-Host ""
        Write-Host "INSTALLED OK"
        Write-Host "  after : $after"
        exit 0
    }
    Write-Host "  commit did not report Success; retrying"
    Start-Sleep -Seconds 4
}

Write-Host ""
Write-Host "!! gave up after $Retries attempts"
Write-Host "   Check on the phone: screen unlocked, USB debugging authorized,"
Write-Host "   USB mode = File Transfer / MTP, and the cable is seated."
exit 1
