$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$destination = Join-Path $repositoryRoot 'code.zip'
$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("ghost-data-package-" + [guid]::NewGuid().ToString('N'))

try {
    New-Item -ItemType Directory -Path $staging | Out-Null
    Copy-Item (Join-Path $repositoryRoot 'README.md') $staging
    Copy-Item $PSScriptRoot (Join-Path $staging 'code') -Recurse
    Get-ChildItem $staging -Directory -Recurse -Force |
        Where-Object { $_.Name -in @('__pycache__', '.venv', 'venv', 'node_modules', '.git') } |
        Sort-Object { $_.FullName.Length } -Descending |
        Remove-Item -Recurse -Force
    Get-ChildItem $staging -File -Recurse -Force |
        Where-Object { $_.Extension -in @('.zip', '.tar', '.gz', '.tgz', '.7z', '.rar') } |
        Remove-Item -Force
    Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $destination -Force
    Write-Output "Created $destination"
} finally {
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
}
