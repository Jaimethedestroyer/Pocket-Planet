param(
  [Parameter(Mandatory = $true)][string]$Primitive,
  [Parameter(Mandatory = $true)][string]$Ancient,
  [Parameter(Mandatory = $true)][string]$Medieval,
  [Parameter(Mandatory = $true)][string]$Industrial,
  [Parameter(Mandatory = $true)][string]$Vegetation,
  [Parameter(Mandatory = $true)][string]$FireLight,
  [Parameter(Mandatory = $true)][string]$Projectile,
  [Parameter(Mandatory = $true)][string]$Impact,
  [Parameter(Mandatory = $true)][string]$Smoke,
  [Parameter(Mandatory = $true)][string]$Banner,
  [string]$OutputDir = "src/assets/sprites",
  [switch]$Overwrite
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

function New-TransparentBitmap([int]$Width, [int]$Height) {
  $bitmap = [System.Drawing.Bitmap]::new(
    $Width,
    $Height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.Dispose()
  return $bitmap
}

function Draw-Grid(
  [string]$SourcePath,
  [int]$Columns,
  [int]$Rows,
  [int]$CellWidth,
  [int]$CellHeight,
  [bool]$PreserveAspect
) {
  $source = [System.Drawing.Bitmap]::FromFile((Resolve-Path $SourcePath))
  $target = New-TransparentBitmap ($Columns * $CellWidth) ($Rows * $CellHeight)
  $graphics = [System.Drawing.Graphics]::FromImage($target)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

  for ($row = 0; $row -lt $Rows; $row++) {
    for ($column = 0; $column -lt $Columns; $column++) {
      $sourceX0 = [int][Math]::Round($column * $source.Width / $Columns)
      $sourceX1 = [int][Math]::Round(($column + 1) * $source.Width / $Columns)
      $sourceY0 = [int][Math]::Round($row * $source.Height / $Rows)
      $sourceY1 = [int][Math]::Round(($row + 1) * $source.Height / $Rows)
      $sourceWidth = $sourceX1 - $sourceX0
      $sourceHeight = $sourceY1 - $sourceY0

      $destX = $column * $CellWidth
      $destY = $row * $CellHeight
      $destWidth = $CellWidth
      $destHeight = $CellHeight

      if ($PreserveAspect) {
        $scale = [Math]::Min(
          ($CellWidth - 4) / $sourceWidth,
          ($CellHeight - 4) / $sourceHeight
        )
        $destWidth = [Math]::Max(1, [int][Math]::Round($sourceWidth * $scale))
        $destHeight = [Math]::Max(1, [int][Math]::Round($sourceHeight * $scale))
        $destX += [int][Math]::Floor(($CellWidth - $destWidth) / 2)
        # Bottom alignment keeps walk-cycle feet and rooted plants on one baseline.
        $destY += $CellHeight - $destHeight - 1
      }

      $sourceRect = [System.Drawing.Rectangle]::new(
        $sourceX0,
        $sourceY0,
        $sourceWidth,
        $sourceHeight
      )
      $destRect = [System.Drawing.Rectangle]::new(
        $destX,
        $destY,
        $destWidth,
        $destHeight
      )
      $graphics.DrawImage(
        $source,
        $destRect,
        $sourceRect,
        [System.Drawing.GraphicsUnit]::Pixel
      )
    }
  }

  $graphics.Dispose()
  $source.Dispose()
  return $target
}

function Normalize-Pixels([System.Drawing.Bitmap]$Bitmap, [string]$Mode) {
  $result = New-TransparentBitmap $Bitmap.Width $Bitmap.Height

  for ($y = 0; $y -lt $Bitmap.Height; $y++) {
    for ($x = 0; $x -lt $Bitmap.Width; $x++) {
      $pixel = $Bitmap.GetPixel($x, $y)

      if ($Mode -eq "people") {
        $maximum = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
        $minimum = [Math]::Min($pixel.R, [Math]::Min($pixel.G, $pixel.B))
        # Saturation rejects a model-painted gray checkerboard without touching masks.
        if ($pixel.A -lt 24 -or ($maximum - $minimum) -lt 35) { continue }
        if ($pixel.R -ge $pixel.G -and $pixel.R -ge $pixel.B) {
          $result.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, 255, 0, 0))
        } elseif ($pixel.G -ge $pixel.B) {
          $result.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, 0, 255, 0))
        } else {
          $result.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, 0, 0, 255))
        }
        continue
      }

      if ($Mode -eq "vegetation") {
        if ($pixel.A -lt 48) { continue }
        $density = [Math]::Max(28, $pixel.R)
        $result.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $density, 0, 0))
        continue
      }

      if ($Mode -eq "red-mask") {
        if ($pixel.A -lt 48) { continue }
        $result.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, 255, 0, 0))
        continue
      }

      if ($Mode -eq "gray-alpha") {
        if ($pixel.A -lt 8) { continue }
        $luminance = [int][Math]::Round(
          $pixel.R * 0.2126 + $pixel.G * 0.7152 + $pixel.B * 0.0722
        )
        $result.SetPixel(
          $x,
          $y,
          [System.Drawing.Color]::FromArgb($pixel.A, $luminance, $luminance, $luminance)
        )
        continue
      }

      if ($Mode -eq "rgba" -or $Mode -eq "rgba-realistic") {
        if ($pixel.A -lt 8) { continue }
        $result.SetPixel($x, $y, $pixel)
        continue
      }

      throw "Unknown normalization mode: $Mode"
    }
  }

  return $result
}

function Remove-EdgeBackground(
  [System.Drawing.Bitmap]$Bitmap,
  [int]$Columns,
  [int]$Rows,
  [int]$CellWidth,
  [int]$CellHeight
) {
  $transparent = [System.Drawing.Color]::Transparent

  for ($row = 0; $row -lt $Rows; $row++) {
    for ($column = 0; $column -lt $Columns; $column++) {
      $cellX = $column * $CellWidth
      $cellY = $row * $CellHeight
      $visited = [bool[]]::new($CellWidth * $CellHeight)
      $queue = [System.Collections.Generic.Queue[int]]::new()

      $isBackground = {
        param([System.Drawing.Color]$pixel)
        $maximum = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
        $minimum = [Math]::Min($pixel.R, [Math]::Min($pixel.G, $pixel.B))
        return $pixel.A -lt 8 -or $maximum -lt 16 -or (
          $minimum -gt 225 -and ($maximum - $minimum) -lt 20
        )
      }

      for ($x = 0; $x -lt $CellWidth; $x++) {
        $queue.Enqueue($x)
        $queue.Enqueue(($CellHeight - 1) * $CellWidth + $x)
      }
      for ($y = 1; $y -lt ($CellHeight - 1); $y++) {
        $queue.Enqueue($y * $CellWidth)
        $queue.Enqueue($y * $CellWidth + $CellWidth - 1)
      }

      while ($queue.Count -gt 0) {
        $index = $queue.Dequeue()
        if ($visited[$index]) { continue }
        $visited[$index] = $true
        $localX = $index % $CellWidth
        $localY = [int][Math]::Floor($index / $CellWidth)
        $pixel = $Bitmap.GetPixel($cellX + $localX, $cellY + $localY)
        if (-not (& $isBackground $pixel)) { continue }
        $Bitmap.SetPixel($cellX + $localX, $cellY + $localY, $transparent)

        if ($localX -gt 0) { $queue.Enqueue($index - 1) }
        if ($localX + 1 -lt $CellWidth) { $queue.Enqueue($index + 1) }
        if ($localY -gt 0) { $queue.Enqueue($index - $CellWidth) }
        if ($localY + 1 -lt $CellHeight) { $queue.Enqueue($index + $CellWidth) }
      }

      # Clear bright checker pixels inside enclosed prop gaps such as jar handles.
      for ($localY = 0; $localY -lt $CellHeight; $localY++) {
        for ($localX = 0; $localX -lt $CellWidth; $localX++) {
          $pixel = $Bitmap.GetPixel($cellX + $localX, $cellY + $localY)
          $maximum = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
          $minimum = [Math]::Min($pixel.R, [Math]::Min($pixel.G, $pixel.B))
          if ($minimum -gt 242 -and ($maximum - $minimum) -lt 12) {
            $Bitmap.SetPixel($cellX + $localX, $cellY + $localY, $transparent)
          }
        }
      }
    }
  }
}

function Apply-BannerMask([System.Drawing.Bitmap]$Bitmap) {
  $result = New-TransparentBitmap $Bitmap.Width $Bitmap.Height
  $graphics = [System.Drawing.Graphics]::FromImage($result)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $points = [System.Drawing.Point[]]@(
    [System.Drawing.Point]::new(3, 6),
    [System.Drawing.Point]::new(3, 58),
    [System.Drawing.Point]::new(56, 47),
    [System.Drawing.Point]::new(43, 32),
    [System.Drawing.Point]::new(56, 17)
  )
  $path.AddPolygon($points)
  $graphics.SetClip($path)
  $graphics.DrawImage($Bitmap, 0, 0)
  $graphics.ResetClip()
  $path.Dispose()
  $graphics.Dispose()
  return $result
}

function Boost-DarkSprite([System.Drawing.Bitmap]$Bitmap) {
  $result = New-TransparentBitmap $Bitmap.Width $Bitmap.Height
  for ($y = 0; $y -lt $Bitmap.Height; $y++) {
    for ($x = 0; $x -lt $Bitmap.Width; $x++) {
      $pixel = $Bitmap.GetPixel($x, $y)
      if ($pixel.A -eq 0) { continue }
      $red = [Math]::Min(255, [int][Math]::Round($pixel.R * 1.55 + 8))
      $green = [Math]::Min(255, [int][Math]::Round($pixel.G * 1.55 + 8))
      $blue = [Math]::Min(255, [int][Math]::Round($pixel.B * 1.55 + 8))
      $result.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($pixel.A, $red, $green, $blue))
    }
  }
  return $result
}

function Clear-VerticalAtlasSeams(
  [System.Drawing.Bitmap]$Bitmap,
  [int]$Columns,
  [int]$CellWidth
) {
  for ($seam = 1; $seam -lt $Columns; $seam++) {
    $center = $seam * $CellWidth
    for ($x = $center - 2; $x -le $center + 1; $x++) {
      for ($y = 0; $y -lt $Bitmap.Height; $y++) {
        $Bitmap.SetPixel($x, $y, [System.Drawing.Color]::Transparent)
      }
    }
  }
}

function Remove-SmallComponents(
  [System.Drawing.Bitmap]$Bitmap,
  [int]$Columns,
  [int]$Rows,
  [int]$CellWidth,
  [int]$CellHeight,
  [int]$MinimumPixels
) {
  $transparent = [System.Drawing.Color]::Transparent

  for ($row = 0; $row -lt $Rows; $row++) {
    for ($column = 0; $column -lt $Columns; $column++) {
      $visited = [bool[]]::new($CellWidth * $CellHeight)
      $cellX = $column * $CellWidth
      $cellY = $row * $CellHeight

      for ($localY = 0; $localY -lt $CellHeight; $localY++) {
        for ($localX = 0; $localX -lt $CellWidth; $localX++) {
          $start = $localY * $CellWidth + $localX
          if ($visited[$start]) { continue }
          $visited[$start] = $true
          if ($Bitmap.GetPixel($cellX + $localX, $cellY + $localY).A -eq 0) { continue }

          $queue = [System.Collections.Generic.Queue[int]]::new()
          $component = [System.Collections.Generic.List[int]]::new()
          $queue.Enqueue($start)

          while ($queue.Count -gt 0) {
            $current = $queue.Dequeue()
            $component.Add($current)
            $currentX = $current % $CellWidth
            $currentY = [int][Math]::Floor($current / $CellWidth)

            for ($offsetY = -1; $offsetY -le 1; $offsetY++) {
              for ($offsetX = -1; $offsetX -le 1; $offsetX++) {
                if ($offsetX -eq 0 -and $offsetY -eq 0) { continue }
                $nextX = $currentX + $offsetX
                $nextY = $currentY + $offsetY
                if ($nextX -lt 0 -or $nextX -ge $CellWidth -or $nextY -lt 0 -or $nextY -ge $CellHeight) { continue }
                $next = $nextY * $CellWidth + $nextX
                if ($visited[$next]) { continue }
                $visited[$next] = $true
                if ($Bitmap.GetPixel($cellX + $nextX, $cellY + $nextY).A -gt 0) {
                  $queue.Enqueue($next)
                }
              }
            }
          }

          if ($component.Count -lt $MinimumPixels) {
            foreach ($index in $component) {
              $removeX = $index % $CellWidth
              $removeY = [int][Math]::Floor($index / $CellWidth)
              $Bitmap.SetPixel($cellX + $removeX, $cellY + $removeY, $transparent)
            }
          }
        }
      }
    }
  }
}

function Align-Cells(
  [System.Drawing.Bitmap]$Bitmap,
  [int]$Columns,
  [int]$Rows,
  [int]$CellWidth,
  [int]$CellHeight,
  [int]$BottomPadding
) {
  $result = New-TransparentBitmap $Bitmap.Width $Bitmap.Height
  $graphics = [System.Drawing.Graphics]::FromImage($result)
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy

  for ($row = 0; $row -lt $Rows; $row++) {
    for ($column = 0; $column -lt $Columns; $column++) {
      $cellX = $column * $CellWidth
      $cellY = $row * $CellHeight
      $minX = $CellWidth
      $maxX = -1
      $maxY = -1

      for ($localY = 0; $localY -lt $CellHeight; $localY++) {
        for ($localX = 0; $localX -lt $CellWidth; $localX++) {
          if ($Bitmap.GetPixel($cellX + $localX, $cellY + $localY).A -eq 0) { continue }
          $minX = [Math]::Min($minX, $localX)
          $maxX = [Math]::Max($maxX, $localX)
          $maxY = [Math]::Max($maxY, $localY)
        }
      }

      if ($maxX -lt 0) { continue }
      $contentCenter = ($minX + $maxX) / 2.0
      $shiftX = [int][Math]::Round(($CellWidth - 1) / 2.0 - $contentCenter)
      $shiftY = ($CellHeight - 1 - $BottomPadding) - $maxY
      $sourceRect = [System.Drawing.Rectangle]::new($cellX, $cellY, $CellWidth, $CellHeight)
      $destRect = [System.Drawing.Rectangle]::new(
        $cellX + $shiftX,
        $cellY + $shiftY,
        $CellWidth,
        $CellHeight
      )
      # Alignment must never leak pixels into the neighboring arithmetic atlas cell.
      $graphics.SetClip([System.Drawing.Rectangle]::new($cellX, $cellY, $CellWidth, $CellHeight))
      $graphics.DrawImage($Bitmap, $destRect, $sourceRect, [System.Drawing.GraphicsUnit]::Pixel)
      $graphics.ResetClip()
    }
  }

  $graphics.Dispose()
  return $result
}

function Export-Atlas(
  [string]$SourcePath,
  [int]$Columns,
  [int]$Rows,
  [int]$CellWidth,
  [int]$CellHeight,
  [bool]$PreserveAspect,
  [string]$Mode,
  [string]$Filename
) {
  $drawn = Draw-Grid $SourcePath $Columns $Rows $CellWidth $CellHeight $PreserveAspect
  $normalizeMode = $Mode
  if ($Mode -eq "rgba-people") {
    Remove-EdgeBackground $drawn $Columns $Rows $CellWidth $CellHeight
    $normalizeMode = "rgba-realistic"
  } elseif ($Mode -eq "rgba-vegetation" -or $Mode -eq "rgba-banner") {
    $normalizeMode = "rgba-realistic"
  }
  $normalized = Normalize-Pixels $drawn $normalizeMode
  $drawn.Dispose()

  if ($Mode -eq "people") {
    Remove-SmallComponents $normalized $Columns $Rows $CellWidth $CellHeight 12
    $aligned = Align-Cells $normalized $Columns $Rows $CellWidth $CellHeight 3
    $normalized.Dispose()
    $normalized = $aligned
  } elseif ($Mode -eq "rgba-people") {
    $aligned = Align-Cells $normalized $Columns $Rows $CellWidth $CellHeight 3
    $normalized.Dispose()
    $normalized = $aligned
  } elseif ($Mode -eq "vegetation" -or $Mode -eq "rgba-vegetation") {
    $aligned = Align-Cells $normalized $Columns $Rows $CellWidth $CellHeight 0
    $normalized.Dispose()
    $normalized = $aligned
    if ($Mode -eq "rgba-vegetation") {
      Clear-VerticalAtlasSeams $normalized $Columns $CellWidth
      # Generated foliage occasionally includes isolated chromatic extraction slivers.
      Remove-SmallComponents $normalized $Columns $Rows $CellWidth $CellHeight 96
      # The conifer source carries one persistent detached sliver at its far-left edge.
      for ($x = $CellWidth; $x -lt ($CellWidth + 24); $x++) {
        for ($y = 0; $y -lt $CellHeight; $y++) {
          $normalized.SetPixel($x, $y, [System.Drawing.Color]::Transparent)
        }
      }
    }
  } elseif ($Mode -eq "rgba-banner") {
    $masked = Apply-BannerMask $normalized
    $normalized.Dispose()
    $normalized = $masked
  }

  if ($Filename -eq "people-industrial.png") {
    $brightened = Boost-DarkSprite $normalized
    $normalized.Dispose()
    $normalized = $brightened
  }

  $outputPath = Join-Path $OutputDir $Filename
  if (Test-Path $outputPath) {
    if (-not $Overwrite) {
      $normalized.Dispose()
      throw "Refusing to overwrite existing sprite: $outputPath"
    }
    [System.IO.File]::Delete((Resolve-Path $outputPath))
  }
  $normalized.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $normalized.Dispose()
  Write-Output $outputPath
}

New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null

Export-Atlas $Primitive 6 1 48 80 $true "rgba-people" "people-primitive.png"
Export-Atlas $Ancient 6 1 48 80 $true "rgba-people" "people-ancient.png"
Export-Atlas $Medieval 6 1 48 80 $true "rgba-people" "people-medieval.png"
Export-Atlas $Industrial 6 1 48 80 $true "rgba-people" "people-industrial.png"
Export-Atlas $Vegetation 2 2 128 128 $true "rgba-vegetation" "vegetation.png"
Export-Atlas $FireLight 4 1 64 64 $false "rgba" "fire-light.png"
Export-Atlas $Projectile 1 1 32 32 $false "rgba-realistic" "war-projectile.png"
Export-Atlas $Impact 4 1 64 64 $false "gray-alpha" "war-impact.png"
Export-Atlas $Smoke 4 1 128 128 $false "gray-alpha" "war-smoke.png"
Export-Atlas $Banner 1 1 64 64 $false "rgba-banner" "war-banner.png"
