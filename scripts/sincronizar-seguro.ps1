# ============================================================
#  SINCRONIZACIÓN SEGURA de Local AI Studio (Windows)
#  Protege perfiles/ y skills-repo/ antes de hacer git pull.
#  Uso:  powershell -ExecutionPolicy Bypass -File scripts\sincronizar-seguro.ps1
# ============================================================
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = Join-Path "respaldos" $stamp

Write-Host "== 1/4 Respaldando perfiles y configuración ==" -ForegroundColor Cyan
New-Item -ItemType Directory -Force $backup | Out-Null
if (Test-Path "perfiles") { Copy-Item "perfiles" (Join-Path $backup "perfiles") -Recurse -Force }
if (Test-Path "active_project.json") { Copy-Item "active_project.json" $backup -Force }
$skillsAntes = 0
if (Test-Path "skills-repo/skills_index.json") {
  $skillsAntes = (Get-Content "skills-repo/skills_index.json" -Raw | ConvertFrom-Json).Count
}
Write-Host "   Respaldo en $backup · skills antes: $skillsAntes"

Write-Host "== 2/4 Guardando cambios locales (stash) y actualizando ==" -ForegroundColor Cyan
git stash push -m "sync-seguro $stamp" --include-untracked 2>$null | Out-Null
git pull --ff-only
git stash pop 2>$null | Out-Null

Write-Host "== 3/4 Restaurando perfiles que falten ==" -ForegroundColor Cyan
$bakPerfiles = Join-Path $backup "perfiles"
if (Test-Path $bakPerfiles) {
  Get-ChildItem -Recurse -File $bakPerfiles | ForEach-Object {
    $rel = $_.FullName.Substring((Resolve-Path $bakPerfiles).Path.Length + 1)
    $dest = Join-Path "perfiles" $rel
    if (-not (Test-Path $dest)) {
      New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
      Copy-Item $_.FullName $dest
      Write-Host "   Restaurado: perfiles/$rel"
    }
  }
}

Write-Host "== 4/4 Verificación ==" -ForegroundColor Cyan
$numPerfiles = (Get-ChildItem -Recurse -Filter *.md "perfiles" -ErrorAction SilentlyContinue).Count
$skillsDespues = 0
if (Test-Path "skills-repo/skills_index.json") {
  $skillsDespues = (Get-Content "skills-repo/skills_index.json" -Raw | ConvertFrom-Json).Count
}
Write-Host "   Perfiles .md en perfiles/: $numPerfiles"
Write-Host "   Skills indexadas: $skillsDespues (antes: $skillsAntes)"
if ($skillsDespues -lt $skillsAntes) {
  Write-Host "   ⚠ Hay menos skills que antes: ejecuta scripts\install-skills.ps1 para reinstalarlas." -ForegroundColor Yellow
} else {
  Write-Host "   ✅ Todo a salvo. Ya puedes abrir Local AI Studio." -ForegroundColor Green
}
