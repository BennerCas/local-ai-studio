#!/usr/bin/env bash
# Instala/actualiza las skills desde Antigravity OS v2 (solo la librería, clon sparse)
# Repo: https://github.com/BennerCas/antigravity-os-v2
set -e
cd "$(dirname "$0")/.."
if [ -d skills-repo/.git ]; then
  echo "Actualizando skills-repo…"; git -C skills-repo pull --ff-only
else
  echo "Clonando skills de antigravity-os-v2 (sparse)…"
  git clone --depth 1 --filter=blob:none --sparse https://github.com/sickn33/agentic-awesome-skills.git skills-repo
  git -C skills-repo sparse-checkout set skills skills_index.json data CATALOG.md
fi
echo "✅ Skills listas en skills-repo/ (la app las detecta automáticamente)"
