$paths = @(
    "$env:LOCALAPPDATA\Programs\KK9\KK9.exe",
    "$env:LOCALAPPDATA\Programs\kk\KK.exe",
    "C:\Program Files\KK9\KK9.exe",
    "C:\Program Files (x86)\KK9\KK9.exe"
)

$foundPath = $null
foreach ($p in $paths) {
    if (Test-Path $p) {
        $foundPath = $p
        break
    }
}

if (-not $foundPath) {
    Write-Host "[错误] 未找到 KK9.exe 或 KK.exe" -ForegroundColor Red
    exit 1
}

Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "🚀 正在以 CDP 调试模式启动 KK9 客户端..." -ForegroundColor Green
Write-Host "程序路径: $foundPath" -ForegroundColor Gray
Write-Host "调试端口: 9222" -ForegroundColor Gray
Write-Host "====================================================" -ForegroundColor Cyan

Start-Process -FilePath $foundPath -ArgumentList "--remote-debugging-port=9222"
Write-Host "KK9 启动成功！" -ForegroundColor Green
