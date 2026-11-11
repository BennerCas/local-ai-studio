# Instala/actualiza las skills desde Antigravity OS v2 (Windows, clon sparse)
# Repo: https://github.com/BennerCas/antigravity-os-v2
Set-Location (Join-Path $PSScriptRoot "..")
if (Test-Path "skills-repo/.git") {
  Write-Host "Actualizando skills-repo..."
  git -C skills-repo pull --ff-only
} else {
  Write-Host "Clonando skills de antigravity-os-v2 (sparse)..."
  git clone --depth 1 --filter=blob:none --sparse https://github.com/sickn33/agentic-awesome-skills.git skills-repo
  git -C skills-repo sparse-checkout set skills skills_index.json data CATALOG.md
}
Write-Host "✅ Skills listas en skills-repo/ (la app las detecta automáticamente)"
