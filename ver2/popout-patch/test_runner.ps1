# Tắt sạch các tiến trình cũ
Stop-Process -Name "iVMS-4200 Lite" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "iVMS-4200" -Force -ErrorAction SilentlyContinue
Stop-Process -Name "MainView" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Đường dẫn thư mục artifacts và ảnh chụp
$artifactDir = "C:\Users\Administrator\.gemini\antigravity\brain\247ffbac-e60b-41c8-a974-56d932003cd6"
if (-not (Test-Path $artifactDir)) {
    New-Item -ItemType Directory -Path $artifactDir -Force
}
$screenshotPath = Join-Path $artifactDir "screenshot.png"
if (Test-Path $screenshotPath) {
    Remove-Item $screenshotPath -Force
}

# 1. Đăng ký Scheduled Task chạy BitrateLauncher.exe với quyền cao nhất (Bypass UAC)
Write-Host "[Runner] Registering Launcher Task..."
$launcherAction = New-ScheduledTaskAction -Execute "f:\ivms\ivmslite\BitrateLauncher.exe" -WorkingDirectory "f:\ivms\ivmslite"
$launcherPrincipal = New-ScheduledTaskPrincipal -UserId "Administrator" -LogonType Interactive -RunLevel Highest
$launcherTask = New-ScheduledTask -Action $launcherAction -Principal $launcherPrincipal
Register-ScheduledTask -TaskName "LaunchIVMS" -InputObject $launcherTask -Force

# Chạy Task để mở iVMS Lite
Write-Host "[Runner] Running Launcher Task..."
Start-ScheduledTask -TaskName "LaunchIVMS"
Start-Sleep -Seconds 15  # Đợi 15 giây để iVMS Lite mở lên và tải camera phát mượt mà

# 2. Tạo script PowerShell con để giả lập click chuột phải và chụp màn hình trong Interactive Session
$subScriptPath = "C:\Users\Administrator\.gemini\antigravity\brain\247ffbac-e60b-41c8-a974-56d932003cd6\scratch\capture_job.ps1"
$subScriptContent = @'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int cButtons, int dwExtraInfo);' -Name MouseHelper -Namespace Win32

# Di chuyển chuột tới vị trí ô camera 1 (khoảng tọa độ X=500, Y=250 trên màn hình RDP)
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(500, 250)
Start-Sleep -Milliseconds 500

# Click chuột phải (RBUTTONDOWN = 0x08, RBUTTONUP = 0x10)
[Win32.MouseHelper]::mouse_event(0x08, 0, 0, 0, 0)
Start-Sleep -Milliseconds 100
[Win32.MouseHelper]::mouse_event(0x10, 0, 0, 0, 0)

Start-Sleep -Seconds 2  # Đợi menu Win32 của bản vá hiển thị

# Chụp ảnh màn hình toàn bộ desktop
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)

$bitmap.Save("C:\Users\Administrator\.gemini\antigravity\brain\247ffbac-e60b-41c8-a974-56d932003cd6\screenshot.png", [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$bitmap.Dispose()
'@

Set-Content -Path $subScriptPath -Value $subScriptContent -Force

# 3. Đăng ký Scheduled Task để chạy script con trong Interactive Session (truy cập được Desktop)
Write-Host "[Runner] Registering Capture Task..."
$captureAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -File `"$subScriptPath`""
$capturePrincipal = New-ScheduledTaskPrincipal -UserId "Administrator" -LogonType Interactive -RunLevel Highest
$captureTask = New-ScheduledTask -Action $captureAction -Principal $capturePrincipal
Register-ScheduledTask -TaskName "CaptureIVMS" -InputObject $captureTask -Force

# Chạy Task click chuột và chụp màn hình
Write-Host "[Runner] Running Capture Task..."
Start-ScheduledTask -TaskName "CaptureIVMS"
Start-Sleep -Seconds 5  # Đợi 5 giây cho task chụp màn hình xong

# Dọn dẹp các Scheduled Task tạm thời
Unregister-ScheduledTask -TaskName "LaunchIVMS" -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "CaptureIVMS" -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "[Runner] Execution finished."
