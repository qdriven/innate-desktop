<#
  真实窗口抓屏（Windows）。

  为什么需要它：CDP 的 Page.captureScreenshot 只拍**渲染进程**的画面，
  原生 WebContentsView 是独立的原生图层——拍不到。W6.7 的缺陷（原生视图盖住
  地址栏与提取面板）正是这样逃过了既有证据截图。验收浏览器 Surface 必须看
  真实窗口。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/capture-window.ps1 -Out <png>

  参数：
    -Out            必填，输出 png 路径
    -WindowTitle    可选，按标题匹配窗口（默认取第一个有主窗口的 electron 进程）
#>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$WindowTitle = ''
)

Add-Type -AssemblyName System.Drawing
$sig = @'
using System;
using System.Runtime.InteropServices;
public class NativeWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
Add-Type -TypeDefinition $sig

$candidates = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.ProcessName -like '*electron*' }
if ($WindowTitle) {
  $candidates = $candidates | Where-Object { $_.MainWindowTitle -like "*$WindowTitle*" }
}
Write-Output ("候选窗口: " + (($candidates | ForEach-Object { "$($_.Id):'$($_.MainWindowTitle)'" }) -join ', '))
$proc = $candidates | Select-Object -First 1
if (-not $proc) { Write-Error '未找到 electron 窗口'; exit 1 }
$hwnd = $proc.MainWindowHandle
[NativeWin]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
# 置顶再取消置顶：确保截图时窗口没有被别的窗口压住
[NativeWin]::SetWindowPos($hwnd, -1, 0, 0, 0, 0, 0x0003) | Out-Null   # HWND_TOPMOST
Start-Sleep -Milliseconds 300
[NativeWin]::SetWindowPos($hwnd, -2, 0, 0, 0, 0, 0x0003) | Out-Null   # HWND_NOTOPMOST
[NativeWin]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 700

$rect = New-Object NativeWin+RECT
[NativeWin]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
# GetWindowRect 返回逻辑坐标；CopyFromScreen 用物理像素——按窗口 DPI 换算
$dpi = [NativeWin]::GetDpiForWindow($hwnd)
$scale = if ($dpi -gt 0) { $dpi / 96.0 } else { 1.0 }
$left = [int]($rect.Left * $scale)
$top = [int]($rect.Top * $scale)
$w = [int](($rect.Right - $rect.Left) * $scale)
$h = [int](($rect.Bottom - $rect.Top) * $scale)
if ($w -le 0 -or $h -le 0) { Write-Error "窗口尺寸异常 $w x $h"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($left, $top, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "captured $w x $h (dpi $dpi) -> $Out"
