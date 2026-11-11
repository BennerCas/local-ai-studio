# ============================================================
#  CLONAR Local AI Studio ACTUALIZADO en C:\antigravityAS
#  Trae la rama arena/efb1744f-local-ai-studio con TODO el trabajo:
#  interfaz v2, Staff AI + Director Hermes, Estudio de Imagen,
#  skills-repo completo (2.959 skills), datos/ y el probador real.
#
#  Uso: pega este archivo en PowerShell y ejecútalo, o corre:
#  powershell -ExecutionPolicy Bypass -File clonar-actualizado.ps1
# ============================================================
$ErrorActionPreference = "Stop"

$base   = "C:\antigravityAS"
$repo   = "https://github.com/BennerCas/local-ai-studio.git"
$rama   = "arena/efb1744f-local-ai-studio"
$destino = Join-Path $base "local-ai-studio"

Write-Host "== Local AI Studio · clon actualizado ==" -ForegroundColor Cyan

# 1) Carpeta base
if (-not (Test-Path $base)) {
  New-Item -ItemType Directory -Force $base | Out-Null
  Write-Host "Carpeta creada: $base"
}
Set-Location $base

# 2) ¿Ya existe el clon?
if (Test-Path (Join-Path $destino ".git")) {
  Write-Host "Ya existe un clon en $destino : lo actualizo en vez de clonar." -ForegroundColor Yellow
  Set-Location $destino
  git fetch origin
  git checkout $rama
  git pull --ff-only origin $rama
} elseif (Test-Path $destino) {
  Write-Host "⚠ Ya existe $destino pero NO es un clon git." -ForegroundColor Red
  Write-Host "  No lo toco (puede ser tu instalación en vivo). Clono al lado como las-v2:"
  git clone --branch $rama --single-branch $repo (Join-Path $base "las-v2")
  $destino = Join-Path $base "las-v2"
  Set-Location $destino
} else {
  Write-Host "Clonando $repo (rama $rama) en $destino ..."
  Write-Host "Incluye skills-repo completo (~128 MB, 10 mil archivos): puede tardar unos minutos."
  git clone --branch $rama --single-branch $repo $destino
  Set-Location $destino
}

# 3) Verificación: debes ver arriba 4e4dabe, a8ab6da y 47c4f27
Write-Host ""
Write-Host "== Últimos commits (el primero debe ser 4e4dabe) ==" -ForegroundColor Cyan
git log --oneline -3
$skills = 0
if (Test-Path "skills-repo\skills_index.json") {
  $skills = (Get-Content "skills-repo\skills_index.json" -Raw | ConvertFrom-Json).Count
}
Write-Host "Skills incluidas en el clon: $skills"
Write-Host "Perfiles .md: " ((Get-ChildItem -Recurse -Filter *.md "perfiles").Count)
Write-Host ""
Write-Host "✅ Clon listo en $destino" -ForegroundColor Green
Write-Host "Siguiente paso · prueba real contra tus motores:"
Write-Host "  npm run probar:rapido"
