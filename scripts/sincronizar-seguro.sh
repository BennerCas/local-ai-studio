#!/usr/bin/env bash
# SINCRONIZACIÓN SEGURA de Local AI Studio (Linux/macOS): protege perfiles/ y skills-repo/
set -e
cd "$(dirname "$0")/.."
stamp=$(date +%Y%m%d-%H%M%S)
backup="respaldos/$stamp"
mkdir -p "$backup"
[ -d perfiles ] && cp -r perfiles "$backup/perfiles"
[ -f active_project.json ] && cp active_project.json "$backup/" || true
skills_antes=0
[ -f skills-repo/skills_index.json ] && skills_antes=$(python3 -c "import json;print(len(json.load(open('skills-repo/skills_index.json'))))" 2>/dev/null || echo 0)
echo "Respaldo en $backup · skills antes: $skills_antes"
git stash push -m "sync-seguro $stamp" --include-untracked 2>/dev/null || true
git pull --ff-only
git stash pop 2>/dev/null || true
if [ -d "$backup/perfiles" ]; then
  (cd "$backup/perfiles" && find . -type f | while read -r f; do
    if [ ! -f "../../perfiles/$f" ]; then mkdir -p "../../perfiles/$(dirname "$f")"; cp "$f" "../../perfiles/$f"; echo "Restaurado: perfiles/$f"; fi
  done)
fi
num_perfiles=$(find perfiles -name '*.md' 2>/dev/null | wc -l)
echo "Perfiles .md: $num_perfiles · Skills: $skills_antes"
echo "✅ Sincronización segura completada."
