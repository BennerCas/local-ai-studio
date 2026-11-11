#!/usr/bin/env python3
"""
Hugging Face Hub downloader for Local AI Studio.
Emits NDJSON progress/result events to stdout and keeps HF_TOKEN strictly in env.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any

try:  # Import perezoso: la validación de argumentos debe funcionar sin la librería instalada
    from huggingface_hub import HfApi, snapshot_download
    from huggingface_hub.hf_api import RepoFile
    from huggingface_hub.utils.tqdm import tqdm as hf_tqdm
except Exception:  # pragma: no cover - entorno sin huggingface_hub
    HfApi = snapshot_download = RepoFile = hf_tqdm = None


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


_EMIT_LOCK = threading.Lock()
_SKIP_DIR_NAMES = {".cache", ".git", "__pycache__", ".huggingface"}
_INVALID_WIN_CHARS = set('<>"|?*')
_REPO_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)?$")


def emit(payload: dict[str, Any]) -> None:
    """Emit a single NDJSON event line to stdout with immediate flush."""
    line = json.dumps(payload, ensure_ascii=False)
    with _EMIT_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def sanitize_error(message: Any, token: str | None = None) -> str:
    """Scrub any token or authorization header from error messages."""
    text = str(message or "Error desconocido")
    if token:
        text = text.replace(token, "[REDACTED]")
    text = re.sub(r"hf_[A-Za-z0-9]{8,}", "[REDACTED]", text)
    text = re.sub(r"(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+", "[REDACTED]", text)
    text = re.sub(
        r"(?i)(authorization\s*[:=]\s*(?:bearer|basic|token)\s+)[^\s\"']+",
        r"\1[REDACTED]",
        text,
    )
    return text


def validate_target_dir(raw_dir: str | None) -> Path:
    """Strictly validate --target-dir before creating or writing anything."""
    if raw_dir is None or not isinstance(raw_dir, str) or not raw_dir.strip():
        raise ValueError("El parametro --target-dir es obligatorio y no puede estar vacio.")

    cleaned = raw_dir.strip()
    if "\x00" in cleaned or any(ord(ch) < 32 for ch in cleaned):
        raise ValueError("El parametro --target-dir contiene caracteres de control invalidos.")

    # Validate Windows path characters outside optional drive prefix (e.g. C:)
    tail = cleaned[2:] if len(cleaned) >= 2 and cleaned[1] == ":" and cleaned[0].isalpha() else cleaned
    if ":" in tail or any(ch in _INVALID_WIN_CHARS for ch in tail):
        raise ValueError("El parametro --target-dir contiene caracteres no permitidos en rutas.")

    try:
        resolved = Path(cleaned).expanduser().resolve()
    except OSError as exc:
        raise ValueError(f"Ruta --target-dir invalida: {exc}") from exc

    if len(resolved.parts) <= 1 or str(resolved) == str(resolved.anchor):
        raise ValueError("No se permite descargar directamente en la raiz del disco.")

    if resolved.exists() and not resolved.is_dir():
        raise ValueError("La ruta --target-dir existe pero corresponde a un archivo, no a una carpeta.")

    return resolved


def validate_repo_id(raw_repo_id: str | None) -> str:
    if raw_repo_id is None or not isinstance(raw_repo_id, str) or not raw_repo_id.strip():
        raise ValueError("El parametro --repo-id es obligatorio.")
    repo_id = raw_repo_id.strip()
    if ".." in repo_id or "\\" in repo_id or not _REPO_ID_RE.match(repo_id):
        raise ValueError(f"Identificador de repositorio invalido: {repo_id}")
    return repo_id


def inspect_repo_stats(
    api: HfApi,
    repo_id: str,
    repo_type: str,
    revision: str | None,
) -> tuple[int, int]:
    """Estimate file count and total bytes via HfApi."""
    info = api.repo_info(
        repo_id=repo_id,
        repo_type=repo_type,
        revision=revision,
        files_metadata=True,
    )
    siblings = getattr(info, "siblings", None) or []
    files_total = len(siblings)
    total_bytes = 0
    has_sizes = False

    for sib in siblings:
        size = getattr(sib, "size", None)
        if size is None:
            lfs = getattr(sib, "lfs", None)
            size = getattr(lfs, "size", None) if lfs is not None else None
        if size is not None:
            has_sizes = True
            total_bytes += int(size)

    if files_total == 0 or not has_sizes:
        tree_files = [
            item
            for item in api.list_repo_tree(
                repo_id=repo_id,
                repo_type=repo_type,
                revision=revision,
                recursive=True,
            )
            if isinstance(item, RepoFile)
        ]
        if tree_files:
            files_total = len(tree_files)
            total_bytes = sum(
                int(
                    item.size
                    if item.size is not None
                    else (item.lfs.size if getattr(item, "lfs", None) else 0)
                )
                for item in tree_files
            )

    return files_total, total_bytes


def detect_onnx_dirs(root_dir: Path, max_depth: int = 2) -> list[str]:
    """Detect directories at depth <= max_depth containing both genai_config.json and .onnx files."""
    found: list[str] = []

    def _scan(current: Path, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            entries = list(current.iterdir())
        except OSError:
            return

        has_genai_cfg = False
        has_onnx_file = False
        subdirs: list[Path] = []

        for entry in entries:
            name_lower = entry.name.lower()
            if entry.is_dir():
                if entry.name not in _SKIP_DIR_NAMES and not entry.name.startswith("."):
                    subdirs.append(entry)
            elif entry.is_file():
                if name_lower == "genai_config.json":
                    has_genai_cfg = True
                elif name_lower.endswith(".onnx"):
                    has_onnx_file = True

        if has_genai_cfg and has_onnx_file:
            found.append(str(current))

        if depth < max_depth:
            for sub in sorted(subdirs):
                _scan(sub, depth + 1)

    _scan(root_dir, 0)
    return found


def compute_local_stats(root_dir: Path) -> tuple[int, int]:
    """Count downloaded model/dataset files and bytes on disk, ignoring .cache/.git."""
    files_count = 0
    total_bytes = 0
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIR_NAMES]
        for fname in filenames:
            fpath = Path(dirpath) / fname
            try:
                total_bytes += fpath.stat().st_size
                files_count += 1
            except OSError:
                pass
    return files_count, total_bytes


class _ProgressCoordinator:
    def __init__(self, expected_files: int, expected_bytes: int) -> None:
        self.expected_files = max(0, expected_files)
        self.expected_bytes = max(0, expected_bytes)
        self._lock = threading.Lock()
        self._last_pct = -1
        self._last_emit = 0.0
        self._transfer_n = 0
        self._transfer_total = 0
        self._reconstruct_n = 0
        self._reconstruct_total = 0
        self._files_done = 0
        self._files_total = self.expected_files

    def update_bar(self, kind: str, n: int | float, total: int | float | None, desc: str) -> None:
        with self._lock:
            if kind == "transfer":
                self._transfer_n = max(self._transfer_n, int(n or 0))
                if total:
                    self._transfer_total = max(self._transfer_total, int(total))
            elif kind == "reconstruct":
                self._reconstruct_n = max(self._reconstruct_n, int(n or 0))
                if total:
                    self._reconstruct_total = max(self._reconstruct_total, int(total))
            elif kind == "files":
                self._files_done = max(self._files_done, int(n or 0))
                if total:
                    self._files_total = max(self._files_total, int(total))

            denom_bytes = max(self.expected_bytes, self._transfer_total, self._reconstruct_total)
            done_bytes = max(self._transfer_n, self._reconstruct_n)

            pct_bytes = (done_bytes * 100.0 / denom_bytes) if denom_bytes > 0 else 0.0
            pct_files = (self._files_done * 100.0 / self._files_total) if self._files_total > 0 else 0.0

            pct = int(min(99, max(pct_bytes, pct_files)))
            now = time.monotonic()

            if pct > self._last_pct or (now - self._last_emit >= 0.6 and pct >= self._last_pct):
                if self._last_pct == pct and (now - self._last_emit) < 1.5:
                    return
                self._last_pct = pct
                self._last_emit = now
                if denom_bytes > 0:
                    mb_done = done_bytes / (1024 * 1024)
                    mb_tot = denom_bytes / (1024 * 1024)
                    msg = f"Descargando ({self._files_done}/{self._files_total or '?'} archivos, {mb_done:.1f}/{mb_tot:.1f} MB)"
                else:
                    msg = desc or f"Descargando archivos ({self._files_done}/{self._files_total or '?'})"
                emit({"event": "progress", "progress": pct, "message": msg})


def make_tqdm_class(coordinator: _ProgressCoordinator) -> type[hf_tqdm]:
    class JsonProgressTqdm(hf_tqdm):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            hf_name = kwargs.get("name") or ""
            desc = str(kwargs.get("desc") or "")
            kwargs["disable"] = False
            kwargs["file"] = io.StringIO()
            super().__init__(*args, **kwargs)
            if hf_name == "huggingface_hub.snapshot_download.transfer":
                self._kind = "transfer"
            elif hf_name == "huggingface_hub.snapshot_download":
                self._kind = "reconstruct"
            elif desc.startswith("Fetching "):
                self._kind = "files"
            else:
                self._kind = "other"

        def display(self, msg: str | None = None, pos: int | None = None) -> None:
            return

        def update(self, n: int | float | None = 1) -> bool | None:
            res = super().update(n)
            if self._kind in ("transfer", "reconstruct", "files"):
                coordinator.update_bar(self._kind, self.n, self.total, str(self.desc or ""))
            return res

        def set_description(self, desc: str | None = None, refresh: bool | None = True) -> None:
            super().set_description(desc, refresh=False)

    return JsonProgressTqdm


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        emit({"event": "error", "error": sanitize_error(message)})
        sys.exit(1)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = JsonArgumentParser(
        description="Descargador de modelos/datasets desde Hugging Face Hub con salida NDJSON."
    )
    parser.add_argument("--repo-id", required=True, help="ID del repositorio en Hugging Face (ej. owner/repo)")
    parser.add_argument(
        "--repo-type",
        default="model",
        choices=["model", "dataset"],
        help="Tipo de repositorio: model o dataset",
    )
    parser.add_argument("--target-dir", required=True, help="Ruta local destino obligatoria")
    parser.add_argument("--revision", default=None, help="Rama, tag o commit opcional")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    token = os.environ.get("HF_TOKEN", "").strip() or None
    try:
        args = parse_args(argv)
        repo_id = validate_repo_id(args.repo_id)
        repo_type = args.repo_type
        revision = args.revision.strip() if isinstance(args.revision, str) and args.revision.strip() else None
        target_path = validate_target_dir(args.target_dir)

        if HfApi is None or snapshot_download is None:
            raise RuntimeError("Falta la dependencia 'huggingface_hub'. Instálala con: pip install huggingface_hub")
        api = HfApi(token=token)
        files_total, total_bytes = inspect_repo_stats(api, repo_id, repo_type, revision)

        target_path.mkdir(parents=True, exist_ok=True)
        emit(
            {
                "event": "start",
                "repoId": repo_id,
                "targetDir": str(target_path),
                "filesTotal": files_total,
                "totalBytes": total_bytes,
            }
        )

        coordinator = _ProgressCoordinator(files_total, total_bytes)
        tqdm_cls = make_tqdm_class(coordinator)

        emit({"event": "progress", "progress": 0, "message": f"Conectando a {repo_id}..."})

        snapshot_download(
            repo_id=repo_id,
            repo_type=repo_type,
            revision=revision,
            local_dir=str(target_path),
            token=token,
            tqdm_class=tqdm_cls,
        )

        files_count, disk_bytes = compute_local_stats(target_path)
        onnx_dirs = detect_onnx_dirs(target_path, max_depth=2)
        emit(
            {
                "event": "complete",
                "targetDir": str(target_path),
                "filesCount": files_count,
                "totalBytes": disk_bytes,
                "hasOnnx": len(onnx_dirs) > 0,
                "onnxDirs": onnx_dirs,
            }
        )
        return 0
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 1
    except Exception as exc:
        emit({"event": "error", "error": sanitize_error(exc, token)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
