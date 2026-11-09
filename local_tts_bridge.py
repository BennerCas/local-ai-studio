#!/usr/bin/env python3
"""Local TTS Bridge for Local AI Studio.

Provides Spanish text-to-speech via `kokoro_onnx` (INT8) with automatic
fallback to `sherpa_onnx` Piper Spanish models stored in
`C:\\antigravityAS\\Modelos -ai-brains`.

Supports three CLI modes:
  - `--status`: Prints JSON describing readiness and available voices.
  - `--text "..." --voice ef_dora --speed 1.0 --out "...wav"`: Synthesizes a WAV file.
  - `--worker`: Persistent stdin/stdout JSON-lines worker keeping loaded models in RAM.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import Any, Sequence

import numpy as np
import soundfile as sf

_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

from tts_spanish_nlp import (
    DEFAULT_MAX_CHUNK_CHARS,
    concat_audio_chunks,
    normalize_spanish_text,
    remove_dc_and_normalize,
    split_spanish_segments,
)


def _configure_stdio_utf8() -> None:
    """Ensure UTF-8 stdin/stdout/stderr on Windows regardless of console codepage."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


_configure_stdio_utf8()

MODELS_ROOT = Path(os.environ.get("LOCAL_AI_MODELS_DIR", r"C:\antigravityAS\Modelos -ai-brains"))
KOKORO_DIR = MODELS_ROOT / "kokoro-tts"
KOKORO_MODEL_PATH = Path(os.environ.get("KOKORO_MODEL_PATH", str(KOKORO_DIR / "kokoro-v1.0.int8.onnx")))
KOKORO_VOICES_PATH = Path(os.environ.get("KOKORO_VOICES_PATH", str(KOKORO_DIR / "voices.bin")))

DEFAULT_VOICE = "ef_dora"
MIN_SPEED = 0.5
MAX_SPEED = 2.0


MAX_KOKORO_CHUNK_PHONEMES = 480


@dataclass(frozen=True)
class VoiceSpec:
    id: str
    label: str
    engine: str
    gender: str
    lang: str
    model_dir: str = ""
    onnx_filename: str = ""
    sid: int = 0
    blend_weights: tuple[tuple[str, float], ...] = ()


KOKORO_VOICES: tuple[VoiceSpec, ...] = (
    VoiceSpec(
        id="ef_dora",
        label="Dora (Kokoro · Español Femenina)",
        engine="kokoro",
        gender="female",
        lang="es",
    ),
    VoiceSpec(
        id="em_alex",
        label="Alex (Kokoro · Español Masculina)",
        engine="kokoro",
        gender="male",
        lang="es",
    ),
    VoiceSpec(
        id="em_santa",
        label="Santa (Kokoro · Español Masculina)",
        engine="kokoro",
        gender="male",
        lang="es",
    ),
    VoiceSpec(
        id="es_blend_editorial",
        label="Sofia Editorial (Kokoro · Mix Femenina)",
        engine="kokoro",
        gender="female",
        lang="es",
        blend_weights=(("ef_dora", 0.70), ("em_alex", 0.30)),
    ),
    VoiceSpec(
        id="es_blend_documental",
        label="Mateo Documental (Kokoro · Mix Masculina)",
        engine="kokoro",
        gender="male",
        lang="es",
        blend_weights=(("em_alex", 0.65), ("em_santa", 0.35)),
    ),
)

# Note: vits-piper-es_ES-mls_10246-low and vits-piper-es_ES-mls_9972-low are excluded
# because they do not contain tokens.txt on disk required by sherpa_onnx.OfflineTtsVitsModelConfig.
PIPER_VOICES: tuple[VoiceSpec, ...] = (
    VoiceSpec(
        id="vits-piper-es_MX-claude-high",
        label="Claude (Piper · Español MX Femenina)",
        engine="piper",
        gender="female",
        lang="es-MX",
        model_dir="vits-piper-es_MX-claude-high",
        onnx_filename="es_MX-claude-high.onnx",
    ),
    VoiceSpec(
        id="vits-piper-es_MX-ald-medium",
        label="Ald (Piper · Español MX Masculina)",
        engine="piper",
        gender="male",
        lang="es-MX",
        model_dir="vits-piper-es_MX-ald-medium",
        onnx_filename="es_MX-ald-medium.onnx",
    ),
    VoiceSpec(
        id="vits-piper-es_ES-davefx-medium",
        label="DaveFX (Piper · Español ES Masculina)",
        engine="piper",
        gender="male",
        lang="es-ES",
        model_dir="vits-piper-es_ES-davefx-medium",
        onnx_filename="es_ES-davefx-medium.onnx",
    ),
    VoiceSpec(
        id="vits-piper-es_AR-daniela-high",
        label="Daniela (Piper · Español AR Femenina)",
        engine="piper",
        gender="female",
        lang="es-AR",
        model_dir="vits-piper-es_AR-daniela-high",
        onnx_filename="es_AR-daniela-high.onnx",
    ),
    VoiceSpec(
        id="vits-piper-es_ES-miro-high",
        label="Miro (Piper · Español ES Masculina)",
        engine="piper",
        gender="male",
        lang="es-ES",
        model_dir="vits-piper-es_ES-miro-high",
        onnx_filename="es_ES-miro-high.onnx",
    ),
    VoiceSpec(
        id="vits-piper-es_ES-carlfm-x_low",
        label="Carlos (Piper · Español ES Ligera)",
        engine="piper",
        gender="male",
        lang="es-ES",
        model_dir="vits-piper-es_ES-carlfm-x_low",
        onnx_filename="es_ES-carlfm-x_low.onnx",
    ),
    VoiceSpec(
        id="vits-piper-es_ES-sharvard-m",
        label="Sharvard M (Piper · Español ES Masculina)",
        engine="piper",
        gender="male",
        lang="es-ES",
        model_dir="vits-piper-es_ES-sharvard-medium",
        onnx_filename="es_ES-sharvard-medium.onnx",
        sid=0,
    ),
    VoiceSpec(
        id="vits-piper-es_ES-sharvard-f",
        label="Sharvard F (Piper · Español ES Femenina)",
        engine="piper",
        gender="female",
        lang="es-ES",
        model_dir="vits-piper-es_ES-sharvard-medium",
        onnx_filename="es_ES-sharvard-medium.onnx",
        sid=1,
    ),
)

VOICE_BY_ID: dict[str, VoiceSpec] = {v.id: v for v in (*KOKORO_VOICES, *PIPER_VOICES)}


# Pre-compiled regexes for markdown/scratchpad sanitization before Spanish NLP normalization
_RE_THINKING = re.compile(r"<think(?:ing)?\b[^>]*>[\s\S]*?</think(?:ing)?>", re.IGNORECASE)
_RE_UNCLOSED_THINKING = re.compile(r"<think(?:ing)?\b[^>]*>[\s\S]*$", re.IGNORECASE)
_RE_FENCED_CODE = re.compile(r"```[\s\S]*?```|~~~[\s\S]*?~~~")
_RE_FENCED_UNCLOSED = re.compile(r"(?:```|~~~)[\s\S]*$")
_RE_MD_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]+\)")
_RE_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_RE_AUTOLINK = re.compile(r"<(?:https?|ftp)://[^>]+>", re.IGNORECASE)
_RE_URL = re.compile(
    r"(?:https?|ftp)://[^\s<>\"')]+(?<![.,;:!?])|www\.[^\s<>\"')]+(?<![.,;:!?])",
    re.IGNORECASE,
)
_RE_INLINE_CODE = re.compile(r"`([^`]*)`")
_RE_HTML_TAG = re.compile(r"</?[A-Za-z][A-Za-z0-9_-]*(?:\s+[^>]*)?>")
_RE_TABLE_SEP = re.compile(r"^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$", re.MULTILINE)
_RE_HRULE = re.compile(r"^\s*[-*_]{3,}\s*$", re.MULTILINE)
_RE_BLOCKQUOTE = re.compile(r"^\s*>+\s*", re.MULTILINE)
_RE_BULLET = re.compile(r"^\s*[-+*]\s+", re.MULTILINE)
_RE_PIPE = re.compile(r"\|+")
_RE_MD_SYMBOLS = re.compile(r"[#*_~`]+")
_RE_EMOJI_MISC = re.compile(r"[\U00010000-\U0010ffff]")
_RE_HAS_SPEAKABLE = re.compile(r"[A-Za-z0-9ÁÉÍÓÚÜÑáéíóúüñ]")


def _sanitize_markdown_and_markup(raw_text: str) -> str:
    """Strip scratchpad blocks, fenced code, URLs, HTML and markdown noise while preserving Spanish cues."""
    if not raw_text:
        return ""

    text = str(raw_text).replace("\r\n", "\n").replace("\r", "\n")
    text = _RE_THINKING.sub(" ", text)
    text = _RE_UNCLOSED_THINKING.sub(" ", text)
    text = _RE_FENCED_CODE.sub(" ", text)
    text = _RE_FENCED_UNCLOSED.sub(" ", text)
    text = _RE_MD_IMAGE.sub(r" \1 ", text)
    text = _RE_MD_LINK.sub(r"\1", text)
    text = _RE_AUTOLINK.sub(" ", text)
    text = _RE_URL.sub(" ", text)
    text = _RE_INLINE_CODE.sub(r"\1", text)
    text = _RE_HTML_TAG.sub(" ", text)
    text = _RE_TABLE_SEP.sub(" ", text)
    text = _RE_HRULE.sub(" ", text)
    text = _RE_BLOCKQUOTE.sub("", text)
    text = _RE_BULLET.sub("", text)
    text = _RE_PIPE.sub(" ", text)
    text = _RE_MD_SYMBOLS.sub("", text)
    text = _RE_EMOJI_MISC.sub(" ", text)
    return text


def clean_text_for_tts(raw_text: str) -> str:
    """Sanitize markup/URLs/scratchpads and return phonetically normalized Spanish text."""
    sanitized = _sanitize_markdown_and_markup(raw_text)
    if not sanitized or not _RE_HAS_SPEAKABLE.search(sanitized):
        return ""
    normalized = normalize_spanish_text(sanitized)
    if not normalized or not _RE_HAS_SPEAKABLE.search(normalized):
        return ""
    return normalized


def prepare_tts_chunks(raw_text: str, max_chars: int = DEFAULT_MAX_CHUNK_CHARS) -> list[str]:
    """Sanitize, phonetically normalize, and split Spanish text into safe TTS chunks."""
    cleaned = clean_text_for_tts(raw_text)
    if not cleaned:
        return []
    return [
        chunk
        for chunk in split_spanish_segments(cleaned, max_chars=max_chars)
        if chunk.strip() and _RE_HAS_SPEAKABLE.search(chunk)
    ]


def _clamp_speed(speed: Any) -> float:
    try:
        val = float(speed)
    except (TypeError, ValueError):
        val = 1.0
    if not np.isfinite(val):
        val = 1.0
    return max(MIN_SPEED, min(MAX_SPEED, val))


def _piper_paths(spec: VoiceSpec) -> tuple[Path, Path, Path]:
    base = MODELS_ROOT / spec.model_dir
    return base / spec.onnx_filename, base / "tokens.txt", base / "espeak-ng-data"


def _is_piper_voice_ready(spec: VoiceSpec) -> bool:
    onnx_path, tokens_path, data_dir = _piper_paths(spec)
    return onnx_path.is_file() and tokens_path.is_file() and data_dir.is_dir()


def _check_kokoro_ready() -> tuple[bool, set[str]]:
    if not KOKORO_MODEL_PATH.is_file() or not KOKORO_VOICES_PATH.is_file():
        return False, set()
    try:
        import espeakng_loader  # noqa: F401
        import kokoro_onnx  # noqa: F401
        import onnxruntime  # noqa: F401
    except Exception:
        return False, set()

    try:
        with np.load(str(KOKORO_VOICES_PATH), allow_pickle=False) as voices_npz:
            available = set(voices_npz.files)
        return len(available) > 0, available
    except Exception:
        return False, set()


def _check_sherpa_importable() -> bool:
    try:
        import sherpa_onnx  # noqa: F401
        return True
    except Exception:
        return False


def _is_kokoro_voice_available(spec: VoiceSpec, available_ids: set[str]) -> bool:
    if spec.blend_weights:
        return all(base_id in available_ids for base_id, _ in spec.blend_weights)
    return spec.id in available_ids


def get_status() -> dict[str, Any]:
    kokoro_ready, available_kokoro_ids = _check_kokoro_ready()
    sherpa_ok = _check_sherpa_importable()

    voices: list[dict[str, str]] = []
    if kokoro_ready:
        for spec in KOKORO_VOICES:
            if _is_kokoro_voice_available(spec, available_kokoro_ids):
                voices.append(
                    {
                        "id": spec.id,
                        "label": spec.label,
                        "engine": spec.engine,
                        "gender": spec.gender,
                        "lang": spec.lang,
                    }
                )

    piper_ready = False
    if sherpa_ok:
        for spec in PIPER_VOICES:
            if _is_piper_voice_ready(spec):
                piper_ready = True
                voices.append(
                    {
                        "id": spec.id,
                        "label": spec.label,
                        "engine": spec.engine,
                        "gender": spec.gender,
                        "lang": spec.lang,
                    }
                )

    return {
        "ok": bool(kokoro_ready or piper_ready),
        "kokoroReady": kokoro_ready,
        "kokoroModelPath": str(KOKORO_MODEL_PATH),
        "voicesPath": str(KOKORO_VOICES_PATH),
        "piperReady": piper_ready,
        "voices": voices,
    }


class TTSRuntime:
    """In-memory TTS engine manager with Kokoro primary and Sherpa Piper ES fallback."""

    def __init__(self) -> None:
        self._kokoro: Any | None = None
        self._kokoro_error: str | None = None
        self._piper_cache: dict[str, Any] = {}

    def _get_cpu_threads(self) -> int:
        raw = os.environ.get("TTS_CPU_THREADS") or os.environ.get("OLIVE_CPU_THREADS") or "4"
        try:
            threads = int(raw)
        except ValueError:
            threads = 4
        # Benchmark on Ryzen AI shows 4 threads yields optimal latency for Kokoro INT8 CPU
        return max(1, min(8, threads))

    def get_kokoro(self) -> Any:
        if self._kokoro is not None:
            return self._kokoro
        if self._kokoro_error is not None:
            raise RuntimeError(self._kokoro_error)

        if not KOKORO_MODEL_PATH.is_file() or not KOKORO_VOICES_PATH.is_file():
            self._kokoro_error = (
                f"Kokoro artifacts not found: model={KOKORO_MODEL_PATH}, voices={KOKORO_VOICES_PATH}"
            )
            raise RuntimeError(self._kokoro_error)

        try:
            import espeakng_loader
            import onnxruntime as ort
            from kokoro_onnx import EspeakConfig, Kokoro

            if hasattr(espeakng_loader, "make_library_available"):
                try:
                    espeakng_loader.make_library_available()
                except Exception:
                    pass

            lib_path = espeakng_loader.get_library_path()
            data_path = espeakng_loader.get_data_path()
            os.environ.setdefault("PHONEMIZER_ESPEAK_LIBRARY", lib_path)
            espeak_cfg = EspeakConfig(lib_path=lib_path, data_path=data_path)

            sess_opts = ort.SessionOptions()
            sess_opts.intra_op_num_threads = self._get_cpu_threads()
            sess_opts.inter_op_num_threads = 1
            sess = ort.InferenceSession(
                str(KOKORO_MODEL_PATH),
                sess_options=sess_opts,
                providers=["CPUExecutionProvider"],
            )
            self._kokoro = Kokoro.from_session(
                sess,
                str(KOKORO_VOICES_PATH),
                espeak_config=espeak_cfg,
            )
            return self._kokoro
        except Exception as exc:
            self._kokoro_error = f"Failed to initialize Kokoro ONNX: {exc}"
            raise RuntimeError(self._kokoro_error) from exc

    def get_piper(self, spec: VoiceSpec) -> Any:
        if not _is_piper_voice_ready(spec):
            raise FileNotFoundError(f"Piper ES voice assets missing for {spec.id}")

        onnx_path, tokens_path, data_dir = _piper_paths(spec)
        cache_key = str(onnx_path)
        if cache_key in self._piper_cache:
            return self._piper_cache[cache_key]

        import sherpa_onnx

        config = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=str(onnx_path),
                    tokens=str(tokens_path),
                    data_dir=str(data_dir),
                ),
                provider="cpu",
                num_threads=self._get_cpu_threads(),
            )
        )
        tts = sherpa_onnx.OfflineTts(config)
        self._piper_cache[cache_key] = tts
        return tts

    def warmup_default(self) -> None:
        """Pre-load primary engine in worker mode to minimize first-request latency."""
        try:
            if KOKORO_MODEL_PATH.is_file() and KOKORO_VOICES_PATH.is_file():
                k = self.get_kokoro()
                if DEFAULT_VOICE in k.voices:
                    k.create("Hola.", voice=DEFAULT_VOICE, speed=1.0, lang="es")
                return
        except Exception:
            pass

        for spec in PIPER_VOICES:
            if _is_piper_voice_ready(spec):
                try:
                    tts = self.get_piper(spec)
                    tts.generate("Hola.", sid=spec.sid, speed=1.0)
                    break
                except Exception:
                    continue

    def _select_piper_fallbacks(self, preferred_gender: str) -> list[VoiceSpec]:
        same_gender = [v for v in PIPER_VOICES if v.gender == preferred_gender and _is_piper_voice_ready(v)]
        other_gender = [v for v in PIPER_VOICES if v.gender != preferred_gender and _is_piper_voice_ready(v)]
        return same_gender + other_gender

    @staticmethod
    def _coerce_chunks(text_or_chunks: str | Sequence[str]) -> list[str]:
        if isinstance(text_or_chunks, str):
            return prepare_tts_chunks(text_or_chunks, max_chars=DEFAULT_MAX_CHUNK_CHARS)
        return [str(chunk).strip() for chunk in text_or_chunks if str(chunk).strip()]

    @staticmethod
    def _resolve_kokoro_voice_target(kokoro: Any, voice_id: str) -> str | np.ndarray:
        spec = VOICE_BY_ID.get(voice_id)
        if spec is not None and spec.engine == "kokoro" and spec.blend_weights:
            blended: np.ndarray | None = None
            for base_id, weight in spec.blend_weights:
                if base_id not in kokoro.voices:
                    raise ValueError(
                        f"Base Kokoro voice '{base_id}' for blend '{voice_id}' not found in {KOKORO_VOICES_PATH}"
                    )
                vec = np.asarray(kokoro.voices[base_id], dtype=np.float32) * float(weight)
                blended = vec if blended is None else (blended + vec)
            if blended is None:
                raise ValueError(f"Blend '{voice_id}' has no constituent voices")
            return blended.astype(np.float32, copy=False)

        if voice_id not in kokoro.voices:
            raise ValueError(f"Kokoro voice '{voice_id}' not found in {KOKORO_VOICES_PATH}")
        return voice_id

    @classmethod
    def _phonemize_kokoro_safe(
        cls,
        kokoro: Any,
        chunk: str,
        max_phonemes: int = MAX_KOKORO_CHUNK_PHONEMES,
    ) -> list[str]:
        """Phonemize a text chunk and subdivide safely if phonemes exceed ``max_phonemes``."""
        clean_chunk = chunk.strip()
        if not clean_chunk or not _RE_HAS_SPEAKABLE.search(clean_chunk):
            return []

        phonemes = kokoro.tokenizer.phonemize(clean_chunk, lang="es")
        if not phonemes or not phonemes.strip():
            return []

        if len(phonemes) <= max_phonemes:
            tokens = kokoro.tokenizer.tokenize(phonemes)
            if not tokens:
                return []
            if len(tokens) <= max_phonemes:
                return [phonemes]

        words = clean_chunk.split()
        if len(words) >= 2:
            mid = len(words) // 2
            left = cls._phonemize_kokoro_safe(kokoro, " ".join(words[:mid]), max_phonemes=max_phonemes)
            right = cls._phonemize_kokoro_safe(kokoro, " ".join(words[mid:]), max_phonemes=max_phonemes)
            return left + right

        # Single massive token fallback: slice phoneme string within safe window
        pieces: list[str] = []
        for idx in range(0, len(phonemes), max_phonemes):
            sub_ph = phonemes[idx : idx + max_phonemes].strip()
            if sub_ph and kokoro.tokenizer.tokenize(sub_ph):
                pieces.append(sub_ph)
        return pieces

    def _synthesize_kokoro(
        self,
        text_or_chunks: str | Sequence[str],
        voice_id: str,
        speed: float,
    ) -> tuple[np.ndarray, int]:
        kokoro = self.get_kokoro()
        voice_target = self._resolve_kokoro_voice_target(kokoro, voice_id)
        chunks = self._coerce_chunks(text_or_chunks)

        audio_chunks: list[np.ndarray] = []
        sample_rate = 24000

        for chunk in chunks:
            phoneme_parts = self._phonemize_kokoro_safe(kokoro, chunk, max_phonemes=MAX_KOKORO_CHUNK_PHONEMES)
            for phonemes in phoneme_parts:
                samples, sr = kokoro.create(
                    phonemes,
                    voice=voice_target,
                    speed=speed,
                    lang="es",
                    is_phonemes=True,
                )
                sample_rate = int(sr)
                arr = np.asarray(samples, dtype=np.float32).reshape(-1)
                if arr.size > 0:
                    audio_chunks.append(arr)

        if not audio_chunks:
            raise RuntimeError("Kokoro produced empty audio samples")

        combined = concat_audio_chunks(audio_chunks, sample_rate, pause_ms=110, crossfade_ms=10)
        normalized = remove_dc_and_normalize(combined, target_peak=0.92, trim_silence=True)
        if normalized.size == 0:
            raise RuntimeError("Kokoro produced silent audio samples after DSP normalization")
        return normalized, sample_rate

    def _synthesize_piper(
        self,
        text_or_chunks: str | Sequence[str],
        spec: VoiceSpec,
        speed: float,
    ) -> tuple[np.ndarray, int]:
        tts = self.get_piper(spec)
        chunks = self._coerce_chunks(text_or_chunks)

        audio_chunks: list[np.ndarray] = []
        sample_rate = 22050

        for chunk in chunks:
            clean_chunk = chunk.strip()
            if not clean_chunk or not _RE_HAS_SPEAKABLE.search(clean_chunk):
                continue
            audio = tts.generate(clean_chunk, sid=spec.sid, speed=speed)
            sample_rate = int(audio.sample_rate)
            arr = np.asarray(audio.samples, dtype=np.float32).reshape(-1)
            if arr.size > 0:
                audio_chunks.append(arr)

        if not audio_chunks:
            raise RuntimeError(f"Piper ({spec.id}) produced empty audio samples")

        combined = concat_audio_chunks(audio_chunks, sample_rate, pause_ms=110, crossfade_ms=10)
        normalized = remove_dc_and_normalize(combined, target_peak=0.92, trim_silence=True)
        if normalized.size == 0:
            raise RuntimeError(f"Piper ({spec.id}) produced silent audio samples after DSP normalization")
        return normalized, sample_rate

    @staticmethod
    def _write_wav(out_path: Path, samples: np.ndarray, sample_rate: int) -> None:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        clipped = np.clip(samples, -1.0, 1.0)
        tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
        try:
            sf.write(str(tmp_path), clipped, sample_rate, format="WAV", subtype="PCM_16")
            os.replace(tmp_path, out_path)
        except Exception:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass
            raise

    def synthesize(
        self,
        text: str,
        voice: str | None = None,
        speed: float = 1.0,
        out_path: str | None = None,
    ) -> dict[str, Any]:
        chunks = prepare_tts_chunks(text, max_chars=DEFAULT_MAX_CHUNK_CHARS)
        if not chunks:
            raise ValueError("El texto limpio no contiene contenido hablable tras sanear Markdown.")

        req_voice = (voice or DEFAULT_VOICE).strip() or DEFAULT_VOICE
        norm_speed = _clamp_speed(speed)

        if out_path and str(out_path).strip():
            target_out = Path(str(out_path).strip()).resolve()
        else:
            fd, tmp_name = tempfile.mkstemp(prefix="local_tts_", suffix=".wav")
            os.close(fd)
            target_out = Path(tmp_name).resolve()

        spec = VOICE_BY_ID.get(req_voice)
        errors: list[str] = []

        # 1. Explicit Piper request
        if spec is not None and spec.engine == "piper":
            try:
                samples, sr = self._synthesize_piper(chunks, spec, norm_speed)
                self._write_wav(target_out, samples, sr)
                return {
                    "ok": True,
                    "engine": "piper",
                    "voice": spec.id,
                    "sampleRate": sr,
                    "outPath": str(target_out),
                }
            except Exception as exc:
                errors.append(f"piper[{spec.id}]: {exc}")

        # 2. Primary Kokoro engine (for known Kokoro voices or unknown/default alias)
        kokoro_voice_id = spec.id if (spec is not None and spec.engine == "kokoro") else DEFAULT_VOICE
        preferred_gender = spec.gender if spec is not None else "female"

        if spec is None or spec.engine == "kokoro":
            try:
                samples, sr = self._synthesize_kokoro(chunks, kokoro_voice_id, norm_speed)
                self._write_wav(target_out, samples, sr)
                return {
                    "ok": True,
                    "engine": "kokoro",
                    "voice": kokoro_voice_id,
                    "sampleRate": sr,
                    "outPath": str(target_out),
                }
            except Exception as exc:
                errors.append(f"kokoro[{kokoro_voice_id}]: {exc}")

        # 3. Automatic fallback to Sherpa-ONNX Piper ES
        for fallback_spec in self._select_piper_fallbacks(preferred_gender):
            try:
                samples, sr = self._synthesize_piper(chunks, fallback_spec, norm_speed)
                self._write_wav(target_out, samples, sr)
                return {
                    "ok": True,
                    "engine": "piper",
                    "voice": fallback_spec.id,
                    "sampleRate": sr,
                    "outPath": str(target_out),
                }
            except Exception as exc:
                errors.append(f"piper_fallback[{fallback_spec.id}]: {exc}")

        raise RuntimeError("No se pudo sintetizar audio TTS. Detalles: " + " | ".join(errors or ["sin motores disponibles"]))


def run_worker(runtime: TTSRuntime) -> int:
    runtime.warmup_default()

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        req_id: Any = None
        try:
            payload = json.loads(line)
            if not isinstance(payload, dict):
                raise ValueError("La petición JSON debe ser un objeto.")
            req_id = payload.get("id")
            text = payload.get("text", "")
            voice = payload.get("voice") or DEFAULT_VOICE
            speed = payload.get("speed", 1.0)
            out_path = payload.get("outPath") or payload.get("out")

            result = runtime.synthesize(text=text, voice=voice, speed=speed, out_path=out_path)
            response = {
                "id": req_id,
                "ok": True,
                "engine": result["engine"],
                "voice": result["voice"],
                "sampleRate": result["sampleRate"],
                "outPath": result["outPath"],
                "error": None,
            }
        except Exception as exc:
            response = {
                "id": req_id,
                "ok": False,
                "engine": None,
                "voice": None,
                "sampleRate": None,
                "outPath": None,
                "error": str(exc),
            }

        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    return 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local TTS Bridge (Kokoro ONNX + Sherpa Piper ES)")
    parser.add_argument("--status", action="store_true", help="Muestra estado JSON y voces disponibles.")
    parser.add_argument("--worker", action="store_true", help="Ejecuta worker persistente JSON-lines en stdin/stdout.")
    parser.add_argument("--text", type=str, default=None, help="Texto a sintetizar.")
    parser.add_argument("--voice", type=str, default=DEFAULT_VOICE, help="ID de voz (default: ef_dora).")
    parser.add_argument("--speed", type=float, default=1.0, help="Velocidad de habla (0.5 - 2.0).")
    parser.add_argument("--out", type=str, default=None, help="Ruta del archivo WAV de salida.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if args.status:
        sys.stdout.write(json.dumps(get_status(), ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return 0

    runtime = TTSRuntime()

    if args.worker:
        return run_worker(runtime)

    if args.text is not None:
        try:
            result = runtime.synthesize(
                text=args.text,
                voice=args.voice,
                speed=args.speed,
                out_path=args.out,
            )
            sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            return 0
        except Exception as exc:
            sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
            return 1

    sys.stdout.write(
        json.dumps(
            {
                "ok": False,
                "error": "Debe especificar --status, --worker o --text.",
            },
            ensure_ascii=False,
        )
        + "\n"
    )
    sys.stdout.flush()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
