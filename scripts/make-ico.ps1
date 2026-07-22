# Builds a multi-resolution Windows .ico from a 256x256 source PNG.
# Windows needs 16/24/32/48/64/128/256 frames for correct taskbar + Explorer
# rendering; a single 256px frame makes Windows fall back to a generic icon.
param(
  [string]$Source  = "$PSScriptRoot\..\desktop\assets\icon.png",
  [string]$OutPath = "$PSScriptRoot\..\desktop\assets\icon.ico"
)

Add-Type -AssemblyName System.Drawing

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source).Path)

# Render each size to PNG bytes (ICO supports embedded PNG frames on Vista+).
$frames = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $frames += ,($ms.ToArray())
  $ms.Dispose()
}
$src.Dispose()

# Assemble ICO: ICONDIR header + one ICONDIRENTRY per frame + concatenated PNGs.
$icoStream = New-Object System.IO.MemoryStream
$writer = [System.IO.BinaryWriter]::new($icoStream)
$writer.Write([UInt16]0)            # reserved
$writer.Write([UInt16]1)            # type = icon
$writer.Write([UInt16]$sizes.Count) # image count

$headerSize = 6 + (16 * $sizes.Count)
$offset = $headerSize
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $data = $frames[$i]
  $dim = if ($s -ge 256) { 0 } else { $s }  # 0 means 256 in ICO
  $writer.Write([byte]$dim)              # width
  $writer.Write([byte]$dim)              # height
  $writer.Write([byte]0)                 # color palette
  $writer.Write([byte]0)                 # reserved
  $writer.Write([UInt16]1)               # color planes
  $writer.Write([UInt16]32)              # bits per pixel
  $writer.Write([UInt32]$data.Length)    # bytes in resource
  $writer.Write([UInt32]$offset)         # offset from start of file
  $offset += $data.Length
}
foreach ($data in $frames) { $writer.Write($data) }
$writer.Flush()

[System.IO.File]::WriteAllBytes($OutPath, $icoStream.ToArray())
$writer.Dispose(); $icoStream.Dispose()
Write-Output ("Wrote multi-resolution ICO ($($sizes.Count) frames) to $OutPath")
