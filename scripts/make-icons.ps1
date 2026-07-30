# Generates icon-512.png, icon-192.png, apple-touch-icon.png (180) into ../icons
Add-Type -AssemblyName System.Drawing

function New-RoundedRectPath {
    param(
        [System.Drawing.RectangleF]$Rect,
        [single]$Radius
    )
    $d = $Radius * 2
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($Rect.X, $Rect.Y, $d, $d, 180, 90)
    $path.AddArc($Rect.Right - $d, $Rect.Y, $d, $d, 270, 90)
    $path.AddArc($Rect.Right - $d, $Rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($Rect.X, $Rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-Icon {
    param(
        [int]$Size,
        [string]$OutPath
    )

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0, 0, 0))
    $g.FillRectangle($bgBrush, 0, 0, $Size, $Size)

    # rounded-rect content sized within center 80% for maskable safety
    $rectSize = [single]($Size * (400.0 / 512.0))
    $rectOffset = [single](($Size - $rectSize) / 2.0)
    $rect = New-Object System.Drawing.RectangleF($rectOffset, $rectOffset, $rectSize, $rectSize)
    $radius = [single]($rectSize * 0.22)

    $path = New-RoundedRectPath -Rect $rect -Radius $radius
    $accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 0x30, 0xD1, 0x58))
    $g.FillPath($accentBrush, $path)

    $fontSize = [single]($Size * (160.0 / 512.0))
    $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold)
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $text = "DC"
    $textSize = $g.MeasureString($text, $font)
    $textX = [single](($Size - $textSize.Width) / 2.0)
    $textY = [single](($Size - $textSize.Height) / 2.0)
    $g.DrawString($text, $font, $textBrush, $textX, $textY)

    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $font.Dispose()
    $textBrush.Dispose()
    $accentBrush.Dispose()
    $bgBrush.Dispose()
    $path.Dispose()
    $g.Dispose()
    $bmp.Dispose()

    Write-Host "Wrote $OutPath ($Size x $Size)"
}

$repoRoot = Join-Path $PSScriptRoot ".."
$iconsDir = Join-Path $repoRoot "icons"
if (-not (Test-Path $iconsDir)) {
    New-Item -ItemType Directory -Path $iconsDir | Out-Null
}

New-Icon -Size 512 -OutPath (Join-Path $iconsDir "icon-512.png")
New-Icon -Size 192 -OutPath (Join-Path $iconsDir "icon-192.png")
New-Icon -Size 180 -OutPath (Join-Path $iconsDir "apple-touch-icon.png")
