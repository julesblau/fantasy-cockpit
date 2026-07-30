# Dev server: HttpListener on 8321, serves repo root, Ctrl+C to stop
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$port = 8321

$mimeMap = @{
    ".html"        = "text/html"
    ".css"         = "text/css"
    ".js"          = "application/javascript"
    ".json"        = "application/manifest+json"
    ".webmanifest" = "application/manifest+json"
    ".png"         = "image/png"
    ".svg"         = "image/svg+xml"
    ".ico"         = "image/x-icon"
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://localhost:$port/"
$listener.Prefixes.Add($prefix)
try {
    $listener.Start()
}
catch {
    Write-Warning "Failed to bind $prefix ($($_.Exception.Message)); falling back to 127.0.0.1"
    $listener = New-Object System.Net.HttpListener
    $prefix = "http://127.0.0.1:$port/"
    $listener.Prefixes.Add($prefix)
    $listener.Start()
}

Write-Host "Serving $repoRoot at $prefix (Ctrl+C to stop)"

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $response = $null
        try {
            $request = $context.Request
            $response = $context.Response

            $localPath = $request.Url.LocalPath
            if ($localPath -eq "/") {
                $localPath = "/index.html"
            }

            $relativePath = ($localPath.TrimStart("/")) -replace "/", "\"
            $filePath = Join-Path $repoRoot $relativePath

            if ((Test-Path $filePath -PathType Container)) {
                $filePath = Join-Path $filePath "index.html"
            }

            $response.Headers.Add("Cache-Control", "no-store")

            if (Test-Path $filePath -PathType Leaf) {
                $ext = [System.IO.Path]::GetExtension($filePath).ToLowerInvariant()
                $contentType = $mimeMap[$ext]
                if (-not $contentType) {
                    $contentType = "application/octet-stream"
                }
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $response.ContentType = $contentType
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
            else {
                $response.StatusCode = 404
                $notFoundBytes = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
                $response.ContentLength64 = $notFoundBytes.Length
                $response.OutputStream.Write($notFoundBytes, 0, $notFoundBytes.Length)
            }

            $response.OutputStream.Close()
        }
        catch {
            # per-request isolation: one flaky request (client abort, locked file) must not kill the listener
            Write-Warning "Request error: $($_.Exception.Message)"
            try {
                if ($response) {
                    $response.StatusCode = 500
                    $errBytes = [System.Text.Encoding]::UTF8.GetBytes("500 Internal Server Error")
                    $response.ContentLength64 = $errBytes.Length
                    $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
                    $response.OutputStream.Close()
                }
            }
            catch {
                # response already broken/closed by the client; nothing more we can do
            }
        }
    }
}
finally {
    $listener.Stop()
    $listener.Close()
    Write-Host "Server stopped."
}
