param([long]$WindowHandle, [string]$ScreenshotPath)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class CompactWindowQA {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
 [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr hwnd, IntPtr region);
 [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int x1,int y1,int x2,int y2);
 [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr region,int x,int y);
 [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
}
"@
[CompactWindowQA]::SetProcessDPIAware() | Out-Null
$rect = New-Object CompactWindowQA+RECT
[CompactWindowQA]::GetWindowRect([IntPtr]$WindowHandle,[ref]$rect) | Out-Null
$width=$rect.Right-$rect.Left
$height=$rect.Bottom-$rect.Top
$region=[CompactWindowQA]::CreateRectRgn(0,0,0,0)
try {
 $kind=[CompactWindowQA]::GetWindowRgn([IntPtr]$WindowHandle,$region)
 $corner=[CompactWindowQA]::PtInRegion($region,0,0)
 $center=[CompactWindowQA]::PtInRegion($region,[int]($width/2),[int]($height/2))
 if ($ScreenshotPath) {
  Add-Type -AssemblyName System.Drawing
  $bitmap=New-Object System.Drawing.Bitmap($width,$height)
  $graphics=[Drawing.Graphics]::FromImage($bitmap)
  try {
   $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size)
   $bitmap.Save($ScreenshotPath,[Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
 }
 @{regionType=$kind;cornerDrawn=$corner;centerDrawn=$center;width=$width;height=$height} | ConvertTo-Json -Compress
} finally { [CompactWindowQA]::DeleteObject($region) | Out-Null }
