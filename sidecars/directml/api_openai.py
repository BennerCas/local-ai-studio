"""
Backend DirectML (ONNX GenAI) de Local AI Studio — versión corregida y
versionada en el repo (sidecars/directml/api_openai.py). El Studio lo
arranca desde aquí si existe; DIRECTML_SCRIPT puede apuntar a otra copia.
Correcciones: UTF-8 forzado, recuperación del MISMO modelo tras un reset
de GPU, error SSE real en streaming, reintento tras recuperación y modelo
por defecto configurable (DIRECTML_DEFAULT_MODEL, Hermes por defecto).
"""
import asyncio
import codecs
from contextlib import asynccontextmanager
import ctypes
import gc
import json
import os
import socket
import struct
import sys
import threading
import time
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

# Salida siempre en UTF-8: en Windows la consola cp1252 hacía explotar el
# propio print() que reportaba un error, ocultando la causa real.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Parche de resiliencia en Windows para evitar WinError 64 / ERROR_NETNAME_DELETED en IocpProactor
if sys.platform == "win32":
    try:
        import _overlapped
        import asyncio.windows_events as we

        def patched_accept(self, listener):
            self._register_with_iocp(listener)
            conn = self._get_accept_socket(listener.family)
            ov = _overlapped.Overlapped(we.NULL)
            ov.AcceptEx(listener.fileno(), conn.fileno())

            def finish_accept(trans, key, ov):
                try:
                    ov.getresult()
                    buf = struct.pack("@P", listener.fileno())
                    conn.setsockopt(socket.SOL_SOCKET, _overlapped.SO_UPDATE_ACCEPT_CONTEXT, buf)
                    conn.settimeout(listener.gettimeout())
                    return conn, conn.getpeername()
                except OSError:
                    try:
                        conn.close()
                    except Exception:
                        pass
                    raise

            async def accept_coro(future, conn):
                try:
                    await future
                except (we.exceptions.CancelledError, OSError):
                    try:
                        conn.close()
                    except Exception:
                        pass

            future = self._register(ov, listener, finish_accept)
            coro = accept_coro(future, conn)
            we.tasks.ensure_future(coro, loop=self._loop)
            return future

        we.IocpProactor.accept = patched_accept
    except Exception as patch_err:
        print(f"[Aviso] No se pudo parchar IocpProactor: {patch_err}")

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import onnxruntime_genai as og
from pydantic import BaseModel, ConfigDict
import uvicorn

# ---------------------------------------------------------
# Configuración de Hardware e Inferencias (GEMINI.md / DirectML)
# ---------------------------------------------------------
os.environ.setdefault("OLIVE_GPU_MEMORY_LIMIT", "25")
os.environ.setdefault("OLIVE_CPU_THREADS", "12")
os.environ.setdefault("ORT_DML_DEVICE_ID", "0")

SERVER_HOST = os.environ.get("DIRECTML_HOST", "127.0.0.1")
SERVER_PORT = int(os.environ.get("DIRECTML_PORT", "8002"))
DIRECTML_MAX_CONTEXT_TOKENS = int(os.environ.get("DIRECTML_MAX_CONTEXT_TOKENS", "8192"))
DIRECTML_MAX_PROMPT_TOKENS = int(os.environ.get("DIRECTML_MAX_PROMPT_TOKENS", "6144"))


# ---------------------------------------------------------
# Binding C-API DirectML sin bloqueo del GIL (ctypes.WinDLL / CDLL)
# ---------------------------------------------------------
# onnxruntime_genai 0.13.1 pybind11 (.pyd) no libera el GIL en append_tokens /
# generate_next_token; invocar la DLL C oficial mediante ctypes libera el GIL
# automáticamente (Py_BEGIN_ALLOW_THREADS) manteniendo /health, /ping y /v1/models
# por debajo de 50 ms incluso durante prefills extensos o inferencia Q8.
class _OgaCAPI:
    def __init__(self) -> None:
        pkg_dir = os.path.dirname(og.__file__)
        if sys.platform == "win32":
            dll_path = os.path.join(pkg_dir, "onnxruntime-genai.dll")
            self._lib = ctypes.WinDLL(dll_path)
        elif sys.platform == "darwin":
            dll_path = os.path.join(pkg_dir, "libonnxruntime-genai.dylib")
            self._lib = ctypes.CDLL(dll_path)
        else:
            dll_path = os.path.join(pkg_dir, "libonnxruntime-genai.so")
            self._lib = ctypes.CDLL(dll_path)

        c_vp = ctypes.c_void_p
        c_cp = ctypes.c_char_p
        c_sz = ctypes.c_size_t
        c_i32 = ctypes.c_int32
        c_i32p = ctypes.POINTER(c_i32)

        lib = self._lib
        lib.OgaShutdown.argtypes = []
        lib.OgaShutdown.restype = None

        lib.OgaResultGetError.argtypes = [c_vp]
        lib.OgaResultGetError.restype = c_cp
        lib.OgaDestroyResult.argtypes = [c_vp]
        lib.OgaDestroyResult.restype = None
        lib.OgaDestroyString.argtypes = [c_vp]
        lib.OgaDestroyString.restype = None

        lib.OgaCreateModel.argtypes = [c_cp, ctypes.POINTER(c_vp)]
        lib.OgaCreateModel.restype = c_vp
        lib.OgaDestroyModel.argtypes = [c_vp]
        lib.OgaDestroyModel.restype = None

        lib.OgaCreateTokenizer.argtypes = [c_vp, ctypes.POINTER(c_vp)]
        lib.OgaCreateTokenizer.restype = c_vp
        lib.OgaDestroyTokenizer.argtypes = [c_vp]
        lib.OgaDestroyTokenizer.restype = None

        lib.OgaCreateSequences.argtypes = [ctypes.POINTER(c_vp)]
        lib.OgaCreateSequences.restype = c_vp
        lib.OgaDestroySequences.argtypes = [c_vp]
        lib.OgaDestroySequences.restype = None
        lib.OgaSequencesGetSequenceCount.argtypes = [c_vp, c_sz]
        lib.OgaSequencesGetSequenceCount.restype = c_sz
        lib.OgaSequencesGetSequenceData.argtypes = [c_vp, c_sz]
        lib.OgaSequencesGetSequenceData.restype = c_i32p

        lib.OgaTokenizerEncode.argtypes = [c_vp, c_cp, c_vp]
        lib.OgaTokenizerEncode.restype = c_vp
        lib.OgaTokenizerApplyChatTemplate.argtypes = [
            c_vp,
            c_cp,
            c_cp,
            c_cp,
            ctypes.c_bool,
            ctypes.POINTER(c_vp),
        ]
        lib.OgaTokenizerApplyChatTemplate.restype = c_vp

        lib.OgaCreateTokenizerStream.argtypes = [c_vp, ctypes.POINTER(c_vp)]
        lib.OgaCreateTokenizerStream.restype = c_vp
        lib.OgaDestroyTokenizerStream.argtypes = [c_vp]
        lib.OgaDestroyTokenizerStream.restype = None
        lib.OgaTokenizerStreamDecode.argtypes = [c_vp, c_i32, ctypes.POINTER(c_cp)]
        lib.OgaTokenizerStreamDecode.restype = c_vp

        lib.OgaCreateGeneratorParams.argtypes = [c_vp, ctypes.POINTER(c_vp)]
        lib.OgaCreateGeneratorParams.restype = c_vp
        lib.OgaDestroyGeneratorParams.argtypes = [c_vp]
        lib.OgaDestroyGeneratorParams.restype = None
        lib.OgaGeneratorParamsSetSearchNumber.argtypes = [c_vp, c_cp, ctypes.c_double]
        lib.OgaGeneratorParamsSetSearchNumber.restype = c_vp
        lib.OgaGeneratorParamsSetSearchBool.argtypes = [c_vp, c_cp, ctypes.c_bool]
        lib.OgaGeneratorParamsSetSearchBool.restype = c_vp

        lib.OgaCreateGenerator.argtypes = [c_vp, c_vp, ctypes.POINTER(c_vp)]
        lib.OgaCreateGenerator.restype = c_vp
        lib.OgaDestroyGenerator.argtypes = [c_vp]
        lib.OgaDestroyGenerator.restype = None
        lib.OgaGenerator_IsDone.argtypes = [c_vp]
        lib.OgaGenerator_IsDone.restype = ctypes.c_bool
        lib.OgaGenerator_AppendTokens.argtypes = [c_vp, c_i32p, c_sz]
        lib.OgaGenerator_AppendTokens.restype = c_vp
        lib.OgaGenerator_GenerateNextToken.argtypes = [c_vp]
        lib.OgaGenerator_GenerateNextToken.restype = c_vp
        lib.OgaGenerator_GetNextTokens.argtypes = [
            c_vp,
            ctypes.POINTER(c_i32p),
            ctypes.POINTER(c_sz),
        ]
        lib.OgaGenerator_GetNextTokens.restype = c_vp

    def check(self, res: Any) -> None:
        if res:
            try:
                raw_msg = self._lib.OgaResultGetError(res)
                msg = raw_msg.decode("utf-8", "replace") if raw_msg else "Error OGA desconocido"
            finally:
                self._lib.OgaDestroyResult(res)
            raise RuntimeError(msg)

    @property
    def lib(self) -> Any:
        return self._lib


_OGA_CAPI: Optional[_OgaCAPI] = None
_OGA_CAPI_LOCK = threading.Lock()


def _get_capi() -> _OgaCAPI:
    global _OGA_CAPI
    if _OGA_CAPI is None:
        with _OGA_CAPI_LOCK:
            if _OGA_CAPI is None:
                _OGA_CAPI = _OgaCAPI()
    return _OGA_CAPI


class DirectMLModel:
    def __init__(self, model_dir: str) -> None:
        self._capi = _get_capi()
        self._ptr = ctypes.c_void_p()
        self._capi.check(self._capi.lib.OgaCreateModel(model_dir.encode("utf-8"), ctypes.byref(self._ptr)))

    @property
    def handle(self) -> ctypes.c_void_p:
        if not self._ptr:
            raise RuntimeError("Modelo DirectML cerrado.")
        return self._ptr

    def close(self) -> None:
        if getattr(self, "_ptr", None):
            ptr = self._ptr
            self._ptr = None
            try:
                self._capi.lib.OgaDestroyModel(ptr)
            except Exception:
                pass

    def __del__(self) -> None:
        self.close()


class DirectMLTokenizerStream:
    def __init__(self, capi: _OgaCAPI, tokenizer_obj: "DirectMLTokenizer") -> None:
        self._capi = capi
        self._tokenizer = tokenizer_obj
        self._ptr = ctypes.c_void_p()
        self._utf8_decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._out_str = ctypes.c_char_p()
        capi.check(capi.lib.OgaCreateTokenizerStream(tokenizer_obj.handle, ctypes.byref(self._ptr)))

    def decode(self, token_id: int) -> str:
        if not self._ptr:
            raise RuntimeError("TokenizerStream cerrado.")
        self._capi.check(
            self._capi.lib.OgaTokenizerStreamDecode(
                self._ptr, ctypes.c_int32(int(token_id)), ctypes.byref(self._out_str)
            )
        )
        raw = self._out_str.value
        if not raw:
            return ""
        return self._utf8_decoder.decode(raw, final=False)

    def flush(self) -> str:
        return self._utf8_decoder.decode(b"", final=True)

    def close(self) -> None:
        if getattr(self, "_ptr", None):
            ptr = self._ptr
            self._ptr = None
            try:
                self._capi.lib.OgaDestroyTokenizerStream(ptr)
            except Exception:
                pass
        self._tokenizer = None  # type: ignore[assignment]

    def __del__(self) -> None:
        self.close()


class DirectMLTokenizer:
    def __init__(self, model_obj: DirectMLModel) -> None:
        self._capi = _get_capi()
        self._model = model_obj
        self._ptr = ctypes.c_void_p()
        self._capi.check(self._capi.lib.OgaCreateTokenizer(model_obj.handle, ctypes.byref(self._ptr)))

    @property
    def handle(self) -> ctypes.c_void_p:
        if not self._ptr:
            raise RuntimeError("Tokenizer DirectML cerrado.")
        return self._ptr

    def apply_chat_template(self, messages_json: str, add_generation_prompt: bool = True) -> str:
        out_ptr = ctypes.c_void_p()
        self._capi.check(
            self._capi.lib.OgaTokenizerApplyChatTemplate(
                self.handle,
                None,
                messages_json.encode("utf-8"),
                None,
                bool(add_generation_prompt),
                ctypes.byref(out_ptr),
            )
        )
        try:
            raw = ctypes.cast(out_ptr, ctypes.c_char_p).value
            return raw.decode("utf-8", "replace") if raw else ""
        finally:
            if out_ptr:
                self._capi.lib.OgaDestroyString(out_ptr)

    def encode(self, text: str) -> List[int]:
        seq_ptr = ctypes.c_void_p()
        self._capi.check(self._capi.lib.OgaCreateSequences(ctypes.byref(seq_ptr)))
        try:
            self._capi.check(self._capi.lib.OgaTokenizerEncode(self.handle, text.encode("utf-8"), seq_ptr))
            count = int(self._capi.lib.OgaSequencesGetSequenceCount(seq_ptr, 0))
            if count <= 0:
                return []
            data_ptr = self._capi.lib.OgaSequencesGetSequenceData(seq_ptr, 0)
            return [int(data_ptr[i]) for i in range(count)]
        finally:
            if seq_ptr:
                self._capi.lib.OgaDestroySequences(seq_ptr)

    def create_stream(self) -> DirectMLTokenizerStream:
        return DirectMLTokenizerStream(self._capi, self)

    def close(self) -> None:
        if getattr(self, "_ptr", None):
            ptr = self._ptr
            self._ptr = None
            try:
                self._capi.lib.OgaDestroyTokenizer(ptr)
            except Exception:
                pass
        self._model = None  # type: ignore[assignment]

    def __del__(self) -> None:
        self.close()


class DirectMLGeneratorParams:
    def __init__(self, model_obj: DirectMLModel) -> None:
        self._capi = _get_capi()
        self._model = model_obj
        self._ptr = ctypes.c_void_p()
        self._capi.check(self._capi.lib.OgaCreateGeneratorParams(model_obj.handle, ctypes.byref(self._ptr)))

    @property
    def handle(self) -> ctypes.c_void_p:
        if not self._ptr:
            raise RuntimeError("GeneratorParams DirectML cerrado.")
        return self._ptr

    def set_search_options(self, **kwargs: Any) -> None:
        for key, val in kwargs.items():
            key_b = str(key).encode("utf-8")
            if isinstance(val, bool):
                self._capi.check(self._capi.lib.OgaGeneratorParamsSetSearchBool(self.handle, key_b, val))
            elif isinstance(val, (int, float)):
                self._capi.check(
                    self._capi.lib.OgaGeneratorParamsSetSearchNumber(self.handle, key_b, float(val))
                )

    def close(self) -> None:
        if getattr(self, "_ptr", None):
            ptr = self._ptr
            self._ptr = None
            try:
                self._capi.lib.OgaDestroyGeneratorParams(ptr)
            except Exception:
                pass
        self._model = None  # type: ignore[assignment]

    def __del__(self) -> None:
        self.close()


class DirectMLGenerator:
    def __init__(self, model_obj: DirectMLModel, params_obj: DirectMLGeneratorParams) -> None:
        self._capi = _get_capi()
        self._model = model_obj
        self._params = params_obj
        self._ptr = ctypes.c_void_p()
        self._out_tokens_ptr = ctypes.POINTER(ctypes.c_int32)()
        self._out_tokens_count = ctypes.c_size_t()
        self._capi.check(
            self._capi.lib.OgaCreateGenerator(model_obj.handle, params_obj.handle, ctypes.byref(self._ptr))
        )

    @property
    def handle(self) -> ctypes.c_void_p:
        if not self._ptr:
            raise RuntimeError("Generator DirectML cerrado.")
        return self._ptr

    def append_tokens(self, input_tokens: List[int]) -> None:
        n = len(input_tokens)
        if n <= 0:
            raise ValueError("input_tokens no puede estar vacío.")
        arr = (ctypes.c_int32 * n)(*(int(t) for t in input_tokens))
        self._capi.check(self._capi.lib.OgaGenerator_AppendTokens(self.handle, arr, n))

    def is_done(self) -> bool:
        return bool(self._capi.lib.OgaGenerator_IsDone(self.handle))

    def generate_next_token(self) -> None:
        self._capi.check(self._capi.lib.OgaGenerator_GenerateNextToken(self.handle))

    def get_next_tokens(self) -> List[int]:
        self._capi.check(
            self._capi.lib.OgaGenerator_GetNextTokens(
                self.handle,
                ctypes.byref(self._out_tokens_ptr),
                ctypes.byref(self._out_tokens_count),
            )
        )
        cnt = int(self._out_tokens_count.value)
        if cnt <= 0 or not self._out_tokens_ptr:
            return []
        return [int(self._out_tokens_ptr[i]) for i in range(cnt)]

    def close(self) -> None:
        if getattr(self, "_ptr", None):
            ptr = self._ptr
            self._ptr = None
            try:
                self._capi.lib.OgaDestroyGenerator(ptr)
            except Exception:
                pass
        self._params = None  # type: ignore[assignment]
        self._model = None  # type: ignore[assignment]

    def __del__(self) -> None:
        self.close()


def _release_runtime_handles() -> None:
    global model, tokenizer, active_model_name, active_model_path
    tok_ref = tokenizer
    mdl_ref = model
    tokenizer = None
    model = None
    active_model_name = "Desconocido"
    active_model_path = ""
    if tok_ref is not None:
        try:
            tok_ref.close()
        except Exception:
            pass
    if mdl_ref is not None:
        try:
            mdl_ref.close()
        except Exception:
            pass
    gc.collect()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        loop = asyncio.get_running_loop()
        orig_handler = loop.get_exception_handler()

        def custom_handler(ev_loop, context):
            exc = context.get("exception")
            if isinstance(exc, OSError) and getattr(exc, "winerror", None) in (64, 121, 10054):
                return
            if orig_handler:
                orig_handler(ev_loop, context)
            else:
                ev_loop.default_exception_handler(context)

        loop.set_exception_handler(custom_handler)
    except Exception:
        pass
    try:
        yield
    finally:
        _release_runtime_handles()
        try:
            if _OGA_CAPI is not None:
                _OGA_CAPI.lib.OgaShutdown()
        except Exception:
            pass


app = FastAPI(title="ONNX GenAI OpenAI API - DirectML", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def measure_dir_size_gb(path: str, fallback: str) -> str:
    try:
        if not os.path.isdir(path):
            return fallback
        total_bytes = 0
        for root, _, files in os.walk(path):
            for fname in files:
                fpath = os.path.join(root, fname)
                try:
                    total_bytes += os.path.getsize(fpath)
                except OSError:
                    pass
        if total_bytes <= 0:
            return fallback
        return f"{total_bytes / (1024 ** 3):.1f} GB"
    except Exception:
        return fallback


# Rutas de modelos compatibles con DirectML
HERMES_PATH = r"C:\antigravityAS\Modelos -ai-brains\Hermes-3-8B-UNLOCKED-ONNX-DirectML"
LLAMA_PATH = r"C:\antigravityAS\Modelos -ai-brains\Llama-3.2-3B-ONNX-DirectML-INT4"
PHI35_PATH = r"C:\antigravityAS\Modelos -ai-brains\phi-3.5-mini-instruct-onnx\gpu\gpu-int4-awq-block-128"
HERMES_INT4_PATH = os.environ.get("HERMES_INT4_PATH", r"C:\antigravityAS\Modelos -ai-brains\Hermes-3-8B-UNLOCKED-INT4")

MODELS_MAP: Dict[str, Dict[str, Any]] = {
    "Phi-3.5-mini-instruct-ONNX": {
        "path": PHI35_PATH,
        "displayName": "Phi-3.5-mini-instruct (INT4 AWQ DirectML)",
        "size": "2.3 GB",
        "ready": True,
    },
    "Llama-3.2-3B-ONNX-DirectML": {
        "path": LLAMA_PATH,
        "displayName": "Llama-3.2-3B-Instruct (INT4 DirectML)",
        "size": measure_dir_size_gb(LLAMA_PATH, "2.3 GB"),
        "ready": True,
    },
    "Hermes-3-8B-UNLOCKED-ONNX-DirectML": {
        "path": HERMES_PATH,
        "displayName": "Hermes-3-8B-UNLOCKED (Q8 ONNX DirectML)",
        "size": "8.5 GB",
        "ready": True,
    },
    "Hermes-3-8B-UNLOCKED-INT4": {
        "path": HERMES_INT4_PATH,
        "displayName": "Hermes-3-8B-UNLOCKED (INT4 AWQ DirectML)",
        "size": measure_dir_size_gb(HERMES_INT4_PATH, "4.5 GB"),
        "ready": True,
    },
}

STOP_SEQUENCES = ["<|eot_id|>", "<|im_end|>", "<|end_of_text|>", "<|end|>", "</s>"]
STOP_TOKEN_IDS = {32000, 32001, 32007, 128001, 128008, 128009, 128040, 100257}

model: Optional[DirectMLModel] = None
tokenizer: Optional[DirectMLTokenizer] = None
active_model_name = "Desconocido"
active_model_path = ""
active_model_stop_tokens: set[int] = set(STOP_TOKEN_IDS)
active_model_context_length: int = DIRECTML_MAX_CONTEXT_TOKENS

# Candado asíncrono para serializar la inferencia GPU DirectML y evitar DXGI_ERROR_DEVICE_RESET
inference_lock = asyncio.Lock()


def is_valid_onnx_model_dir(path: str) -> bool:
    if not path or not os.path.exists(path) or not os.path.isdir(path):
        return False
    has_config = os.path.exists(os.path.join(path, "genai_config.json"))
    has_onnx = any(f.endswith(".onnx") for f in os.listdir(path))
    return has_config and has_onnx


def _read_model_metadata(model_dir: str) -> Tuple[set[int], int]:
    stop_ids = set(STOP_TOKEN_IDS)
    model_ctx = DIRECTML_MAX_CONTEXT_TOKENS
    cfg_file = os.path.join(model_dir, "genai_config.json")
    if os.path.exists(cfg_file):
        try:
            with open(cfg_file, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            eos = cfg.get("model", {}).get("eos_token_id")
            if isinstance(eos, list):
                stop_ids.update(int(x) for x in eos)
            elif isinstance(eos, int):
                stop_ids.add(eos)

            candidates = []
            m_ctx = cfg.get("model", {}).get("context_length")
            s_max = cfg.get("search", {}).get("max_length")
            if isinstance(m_ctx, int) and m_ctx > 0:
                candidates.append(m_ctx)
            if isinstance(s_max, int) and s_max > 0:
                candidates.append(s_max)
            if candidates:
                model_ctx = min(min(candidates), DIRECTML_MAX_CONTEXT_TOKENS)
        except Exception:
            pass
    return stop_ids, max(512, model_ctx)


def resolve_model_key(target: Optional[str]) -> Optional[str]:
    if not target:
        return None
    clean = str(target).strip()
    if clean.startswith("directml:"):
        clean = clean[len("directml:") :].strip()
    if not clean:
        return None
    for k in MODELS_MAP:
        if k.lower() == clean.lower():
            return k
    for k in MODELS_MAP:
        if clean.lower() in k.lower():
            return k
    return None


def load_named_model(target_name: str) -> bool:
    global model, tokenizer, active_model_name, active_model_path
    global active_model_stop_tokens, active_model_context_length

    resolved = resolve_model_key(target_name)
    if not resolved or resolved not in MODELS_MAP:
        return False
    entry = MODELS_MAP[resolved]
    if not entry.get("ready", True):
        print(f"Aviso: {resolved} tiene ready=False (pendiente de cuantización según GEMINI.md).")
        return False
    target_path = entry["path"]
    if not is_valid_onnx_model_dir(target_path):
        return False
    if active_model_name == resolved and model is not None and tokenizer is not None:
        return True
    try:
        print(f"Cargando modelo DirectML: {resolved} ({entry['displayName']})...")
        had_previous = model is not None
        _release_runtime_handles()
        if had_previous:
            # Sin esta pausa, crear el modelo nuevo (hasta 8,5 GB) mientras la
            # VRAM del anterior aún se libera provoca DXGI_ERROR_DEVICE_RESET
            # (0x887A0007) en la primera inferencia tras el cambio.
            gc.collect()
            time.sleep(0.6)
        active_model_stop_tokens = set(STOP_TOKEN_IDS)
        active_model_context_length = DIRECTML_MAX_CONTEXT_TOKENS

        new_model = DirectMLModel(target_path)
        new_tok = DirectMLTokenizer(new_model)
        stop_ids, model_ctx = _read_model_metadata(target_path)

        model = new_model
        tokenizer = new_tok
        active_model_name = resolved
        active_model_path = target_path
        active_model_stop_tokens = stop_ids
        active_model_context_length = model_ctx
        print(f"¡Modelo {active_model_name} cargado exitosamente en DirectML (ctx={model_ctx})!")
        return True
    except Exception as e:
        print(f"Error cargando {resolved}: {e}")
        _release_runtime_handles()
        return False


# Modelo que se carga al arrancar y al que vuelve /v1/models/reload.
# Hermes es el Director del Staff AI: cargarlo de entrada evita el doble
# arranque (Phi primero, Hermes después) y el cambio de modelo en caliente.
DEFAULT_MODEL = os.environ.get("DIRECTML_DEFAULT_MODEL", "Hermes-3-8B-UNLOCKED-ONNX-DirectML")


def load_model_with_fallback(prefer: Optional[str] = None):
    print("=========================================================")
    print("Inicializando Servidor API DirectML - AMD Ryzen AI")
    print("Verificando modelos disponibles en C:\\antigravityAS\\Modelos -ai-brains...")
    print("=========================================================")

    # 0. Prioridad: el modelo preferido (por defecto, el Director Hermes)
    first = prefer or DEFAULT_MODEL
    if first and load_named_model(first):
        return

    # 1. Prioridad: Phi-3.5 mini instruct INT4 AWQ (Ligero 2.3GB, DirectML Nativo Alta Eficiencia)
    if load_named_model("Phi-3.5-mini-instruct-ONNX"):
        return

    # 2. Alternativa ligera: Llama-3.2-3B-Instruct INT4
    if load_named_model("Llama-3.2-3B-ONNX-DirectML"):
        return

    # 3. Alternativa: Hermes-3-8B Q8
    if load_named_model("Hermes-3-8B-UNLOCKED-ONNX-DirectML"):
        return

    raise RuntimeError("No se encontró ningún modelo DirectML optimizado válido en C:\\antigravityAS\\Modelos -ai-brains.")


def recover_device_if_needed(error: Exception):
    """Reinicializa el dispositivo DirectML si hubo un crash de hardware / CommandQueue.

    Recarga el MISMO modelo que estaba activo (antes se recargaba Phi-3.5,
    el primero de la cadena de fallback, y el siguiente chat tenía que
    volver a cargar Hermes: doble recarga y minutos perdidos).
    """
    print(f"[RECOVERY] Reinicializando dispositivo DirectML tras error: {error}...")
    previous = active_model_name
    try:
        _release_runtime_handles()
        gc.collect()
        time.sleep(1.0)  # que el driver termine de resetear el dispositivo
        if previous and previous in MODELS_MAP and load_named_model(previous):
            print(f"[RECOVERY] Dispositivo DirectML reestablecido con {previous}.")
            return
        load_model_with_fallback()
        print("[RECOVERY] Dispositivo DirectML reestablecido exitosamente.")
    except Exception as rec_err:
        print(f"[RECOVERY ERROR] Falló reinicialización DirectML: {rec_err}")


def _check_port_in_use_at_boot(host: str, port: int) -> None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as _s:
            _s.settimeout(0.5)
            if _s.connect_ex((host, port)) == 0:
                print(f"[AVISO] El puerto {port} ya está activo con otra instancia DirectML. Saliendo limpiamente.")
                sys.exit(0)
    except SystemExit:
        raise
    except Exception:
        pass


if os.environ.get("DIRECTML_SKIP_BOOT_LOAD") != "1":
    _check_port_in_use_at_boot(SERVER_HOST, SERVER_PORT)
    try:
        load_model_with_fallback()
    except Exception as err:
        print(f"Fallo al iniciar el runtime DirectML: {err}")
        sys.exit(1)


class ChatMessage(BaseModel):
    role: str
    content: str
    model_config = ConfigDict(extra="ignore")


class ChatCompletionRequest(BaseModel):
    model: Optional[str] = None
    messages: List[ChatMessage]
    temperature: float = 0.7
    top_p: float = 0.9
    max_tokens: int = 1024
    stream: bool = False
    model_config = ConfigDict(extra="ignore")


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": model is not None,
        "model": active_model_name,
        "model_path": active_model_path,
        "backend": "DirectML",
        "provider": "DmlExecutionProvider",
        "port": SERVER_PORT,
    }


@app.get("/ping")
async def ping():
    return {"status": "ok"}


@app.get("/v1/models")
async def get_models():
    models_data = []
    now_ts = int(time.time())
    for m_id, m_info in MODELS_MAP.items():
        is_dir_valid = is_valid_onnx_model_dir(m_info["path"])
        ready = bool(is_dir_valid and m_info.get("ready", True))
        models_data.append(
            {
                "id": m_id,
                "object": "model",
                "displayName": m_info["displayName"],
                "size": m_info["size"],
                "created": now_ts,
                "owned_by": "local-directml",
                "active": (m_id == active_model_name),
                "ready": ready,
                "status": "ready" if ready else "pending_quantization",
            }
        )
    return {"object": "list", "data": models_data}


@app.post("/v1/models/reload")
async def reload_model():
    """Permite recargar en caliente el modelo predeterminado."""
    async with inference_lock:
        try:
            await asyncio.to_thread(load_model_with_fallback)
            return {
                "status": "ok",
                "active_model": active_model_name,
                "active_path": active_model_path,
            }
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))


@app.post("/v1/models/load")
async def load_model_endpoint(req: Request):
    """Permite cargar explícitamente un modelo seleccionado desde el dropdown."""
    try:
        body = await req.json()
    except Exception:
        body = {}
    target = body.get("model") or body.get("id")
    if not target:
        raise HTTPException(status_code=400, detail="Se requiere el campo 'model' con el ID.")

    matched_key = resolve_model_key(target)
    if not matched_key:
        raise HTTPException(status_code=404, detail=f"Modelo DirectML '{target}' no encontrado.")

    entry = MODELS_MAP[matched_key]
    if not entry.get("ready", True):
        raise HTTPException(
            status_code=400,
            detail=f"El modelo '{matched_key}' no está listo (ready=False / pending_quantization).",
        )
    if not is_valid_onnx_model_dir(entry["path"]):
        raise HTTPException(
            status_code=409,
            detail=f"Artefactos ONNX inválidos o faltantes para '{matched_key}' en '{entry['path']}'.",
        )

    async with inference_lock:
        try:
            ok = await asyncio.to_thread(load_named_model, matched_key)
            if not ok:
                raise HTTPException(
                    status_code=500,
                    detail=f"No se pudo inicializar {matched_key} en el dispositivo DirectML.",
                )
            return {
                "status": "ok",
                "active_model": active_model_name,
                "displayName": entry["displayName"],
                "size": entry["size"],
            }
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Error cargando {matched_key} en DirectML: {str(e)}")


def get_model_stop_tokens() -> set[int]:
    return set(active_model_stop_tokens)


def get_model_context_length() -> int:
    return active_model_context_length


def validate_kv_budget(prompt_len: int, requested_max_tokens: int, model_ctx: Optional[int] = None) -> Tuple[int, int, int]:
    """Guardia anti-OOM para caché KV en DirectML (iGPU Radeon 860M)."""
    ctx = model_ctx if model_ctx is not None else get_model_context_length()
    if prompt_len <= 0:
        raise HTTPException(status_code=400, detail="El prompt codificado no puede estar vacío.")
    safe_prompt_limit = min(DIRECTML_MAX_PROMPT_TOKENS, max(256, ctx - 512))
    if prompt_len > safe_prompt_limit:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Prompt demasiado largo para caché KV DirectML ({prompt_len} tokens > "
                f"límite seguro {safe_prompt_limit} de contexto={ctx})."
            ),
        )
    req_max = max(1, int(requested_max_tokens or 1024))
    max_length = min(prompt_len + req_max, ctx)
    if max_length <= prompt_len:
        raise HTTPException(
            status_code=400,
            detail=f"Sin margen de salida disponible (prompt={prompt_len}, ctx={ctx}).",
        )
    return safe_prompt_limit, max_length, ctx


def format_prompt(messages: List[ChatMessage], tok_obj: Optional[DirectMLTokenizer], model_name: str) -> str:
    if tok_obj is not None:
        try:
            raw_msgs = [{"role": msg.role, "content": msg.content} for msg in messages]
            rendered = tok_obj.apply_chat_template(json.dumps(raw_msgs), add_generation_prompt=True)
            if rendered:
                return rendered
        except Exception:
            pass

    active_lower = model_name.lower()
    if "phi" in active_lower:
        prompt = ""
        for msg in messages:
            prompt += f"<|{msg.role}|>\n{msg.content}<|end|>\n"
        prompt += "<|assistant|>\n"
        return prompt
    if "hermes" in active_lower:
        prompt = ""
        for msg in messages:
            prompt += f"<|im_start|>{msg.role}\n{msg.content}<|im_end|>\n"
        prompt += "<|im_start|>assistant\n"
        return prompt

    prompt = "<|begin_of_text|>"
    for msg in messages:
        prompt += f"<|start_header_id|>{msg.role}<|end_header_id|>\n\n{msg.content}<|eot_id|>"
    prompt += "<|start_header_id|>assistant<|end_header_id|>\n\n"
    return prompt


def _prepare_tokens_sync(
    expected_model_key: Optional[str],
    messages: List[ChatMessage],
    requested_max_tokens: int,
) -> Tuple[List[int], int, str]:
    if expected_model_key and expected_model_key != active_model_name:
        ok = load_named_model(expected_model_key)
        if not ok:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"No se pudo activar el modelo '{expected_model_key}' en DirectML "
                    f"(modelo activo: '{active_model_name}')."
                ),
            )

    if model is None or tokenizer is None:
        raise HTTPException(status_code=503, detail="Runtime DirectML sin modelo activo cargado.")

    prompt = format_prompt(messages, tokenizer, active_model_name)
    safe_prompt = prompt.encode("utf-8", "ignore").decode("utf-8")
    input_tokens = tokenizer.encode(safe_prompt)
    _, max_length, _ = validate_kv_budget(len(input_tokens), requested_max_tokens, get_model_context_length())
    return input_tokens, max_length, active_model_name


def _apply_search_options(params: DirectMLGeneratorParams, max_length: int, temperature: float, top_p: float) -> None:
    temp = max(0.0, float(temperature))
    if temp <= 0.01:
        params.set_search_options(
            max_length=max_length,
            do_sample=False,
        )
    else:
        params.set_search_options(
            max_length=max_length,
            do_sample=True,
            temperature=temp,
            top_p=max(0.01, min(1.0, float(top_p))),
        )


def run_generation_sync(
    input_tokens: List[int],
    max_length: int,
    temperature: float = 0.7,
    top_p: float = 0.9,
) -> Dict[str, Any]:
    cur_model = model
    cur_tok = tokenizer
    cur_name = active_model_name
    if cur_model is None or cur_tok is None:
        raise RuntimeError("No hay ningún modelo DirectML cargado.")

    stop_ids = get_model_stop_tokens()
    params: Optional[DirectMLGeneratorParams] = None
    generator: Optional[DirectMLGenerator] = None
    tokenizer_stream: Optional[DirectMLTokenizerStream] = None
    response_chunks: List[str] = []
    finish_reason = "stop"

    try:
        params = DirectMLGeneratorParams(cur_model)
        _apply_search_options(params, max_length=max_length, temperature=temperature, top_p=top_p)

        generator = DirectMLGenerator(cur_model, params)
        generator.append_tokens(input_tokens)
        tokenizer_stream = cur_tok.create_stream()

        generated_count = 0
        max_new = max(1, max_length - len(input_tokens))
        while not generator.is_done():
            generator.generate_next_token()
            new_tokens = generator.get_next_tokens()
            if not new_tokens:
                break
            tok_id = new_tokens[0]
            if tok_id in stop_ids:
                break
            token_text = tokenizer_stream.decode(tok_id)
            if any(seq in token_text for seq in STOP_SEQUENCES):
                break
            if token_text:
                response_chunks.append(token_text)
            generated_count += 1
            if generated_count >= max_new:
                finish_reason = "length"
                break
        tail = tokenizer_stream.flush()
        if tail and not any(seq in tail for seq in STOP_SEQUENCES):
            response_chunks.append(tail)
    finally:
        for obj in (tokenizer_stream, generator, params):
            if obj is not None:
                try:
                    obj.close()
                except Exception:
                    pass

    response_text = "".join(response_chunks)
    created_time = int(time.time())
    completion_tokens = len(cur_tok.encode(response_text)) if response_text else 0
    return {
        "id": f"chatcmpl-dml-{created_time}",
        "object": "chat.completion",
        "created": created_time,
        "model": cur_name,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": response_text},
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": len(input_tokens),
            "completion_tokens": completion_tokens,
            "total_tokens": len(input_tokens) + completion_tokens,
        },
    }


def _emit_to_queue(loop: asyncio.AbstractEventLoop, queue: asyncio.Queue, item: Tuple[str, Any]) -> None:
    try:
        loop.call_soon_threadsafe(queue.put_nowait, item)
    except RuntimeError:
        pass


def _stream_generation_worker(
    loop: asyncio.AbstractEventLoop,
    queue: asyncio.Queue,
    cancel_event: threading.Event,
    expected_model_key: Optional[str],
    messages: List[ChatMessage],
    input_tokens: List[int],
    max_length: int,
    requested_max_tokens: int,
    temperature: float,
    top_p: float,
) -> None:
    params: Optional[DirectMLGeneratorParams] = None
    generator: Optional[DirectMLGenerator] = None
    tokenizer_stream: Optional[DirectMLTokenizerStream] = None
    created_time = int(time.time())
    finish_reason = "stop"

    try:
        if expected_model_key and expected_model_key != active_model_name:
            input_tokens, max_length, _ = _prepare_tokens_sync(
                expected_model_key, messages, requested_max_tokens
            )

        cur_model = model
        cur_tok = tokenizer
        cur_name = active_model_name
        if cur_model is None or cur_tok is None:
            raise RuntimeError("No hay ningún modelo DirectML cargado.")

        stop_ids = get_model_stop_tokens()
        params = DirectMLGeneratorParams(cur_model)
        _apply_search_options(params, max_length=max_length, temperature=temperature, top_p=top_p)

        generator = DirectMLGenerator(cur_model, params)
        generator.append_tokens(input_tokens)
        tokenizer_stream = cur_tok.create_stream()

        generated_count = 0
        max_new = max(1, max_length - len(input_tokens))
        while not generator.is_done() and not cancel_event.is_set():
            generator.generate_next_token()
            if cancel_event.is_set():
                break
            new_tokens = generator.get_next_tokens()
            if not new_tokens:
                break
            new_token = new_tokens[0]
            if new_token in stop_ids:
                break
            try:
                token_text = tokenizer_stream.decode(new_token)
            except Exception:
                token_text = ""

            if any(seq in token_text for seq in STOP_SEQUENCES):
                break

            if token_text:
                chunk = {
                    "id": f"chatcmpl-dml-{created_time}",
                    "object": "chat.completion.chunk",
                    "created": created_time,
                    "model": cur_name,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": token_text},
                            "finish_reason": None,
                        }
                    ],
                }
                _emit_to_queue(loop, queue, ("chunk", f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"))

            generated_count += 1
            if generated_count >= max_new:
                finish_reason = "length"
                break

        if not cancel_event.is_set():
            tail = tokenizer_stream.flush() if tokenizer_stream is not None else ""
            if tail and not any(seq in tail for seq in STOP_SEQUENCES):
                tail_chunk = {
                    "id": f"chatcmpl-dml-{created_time}",
                    "object": "chat.completion.chunk",
                    "created": created_time,
                    "model": cur_name,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": tail},
                            "finish_reason": None,
                        }
                    ],
                }
                _emit_to_queue(loop, queue, ("chunk", f"data: {json.dumps(tail_chunk, ensure_ascii=False)}\n\n"))

            chunk_done = {
                "id": f"chatcmpl-dml-{created_time}",
                "object": "chat.completion.chunk",
                "created": created_time,
                "model": cur_name,
                "choices": [
                    {
                        "index": 0,
                        "delta": {},
                        "finish_reason": finish_reason,
                    }
                ],
            }
            _emit_to_queue(loop, queue, ("done", f"data: {json.dumps(chunk_done, ensure_ascii=False)}\n\n"))
    except Exception as e:
        if not cancel_event.is_set():
            print(f"[Streaming Error] {e}")
            import traceback

            traceback.print_exc()
            recover_device_if_needed(e)
            # Error SSE de verdad: jamás como delta.content, porque los
            # clientes lo pintan como si lo hubiera dicho el modelo.
            err_obj = {"error": {"message": f"DirectML inference error: {str(e)}", "type": "directml_error", "code": "inference_error"}}
            _emit_to_queue(loop, queue, ("error", f"data: {json.dumps(err_obj, ensure_ascii=False)}\n\n"))
    finally:
        for obj in (tokenizer_stream, generator, params):
            if obj is not None:
                try:
                    obj.close()
                except Exception:
                    pass


async def generate_stream_safe(
    request: Request,
    expected_model_key: Optional[str],
    messages: List[ChatMessage],
    input_tokens: List[int],
    max_length: int,
    requested_max_tokens: int,
    temperature: float = 0.7,
    top_p: float = 0.9,
) -> AsyncGenerator[str, None]:
    async with inference_lock:
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Tuple[str, Any]] = asyncio.Queue()
        cancel_event = threading.Event()
        worker_task = asyncio.create_task(
            asyncio.to_thread(
                _stream_generation_worker,
                loop,
                queue,
                cancel_event,
                expected_model_key,
                messages,
                input_tokens,
                max_length,
                requested_max_tokens,
                temperature,
                top_p,
            )
        )
        try:
            while True:
                if await request.is_disconnected():
                    cancel_event.set()
                    print("[DirectML Stream] Cliente desconectado; deteniendo generador.")
                    break
                try:
                    kind, payload = await asyncio.wait_for(queue.get(), timeout=0.05)
                except asyncio.TimeoutError:
                    if worker_task.done() and queue.empty():
                        break
                    continue

                if kind == "chunk":
                    yield payload
                elif kind in ("done", "error"):
                    yield payload
                    yield "data: [DONE]\n\n"
                    break
        except (asyncio.CancelledError, GeneratorExit):
            cancel_event.set()
            print("[DirectML Stream] Cliente desconectado limpiamente.")
            return
        finally:
            cancel_event.set()
            try:
                await worker_task
            except (asyncio.CancelledError, Exception):
                pass


@app.post("/v1/chat/completions")
async def chat_completions(req: ChatCompletionRequest, request: Request):
    if req.max_tokens is not None and int(req.max_tokens) < 1:
        raise HTTPException(status_code=400, detail="max_tokens debe ser >= 1.")

    requested_model = (req.model or "").strip()
    if requested_model.startswith("directml:"):
        requested_model = requested_model[len("directml:") :].strip()

    expected_model_key: Optional[str] = None
    if requested_model:
        expected_model_key = resolve_model_key(requested_model) or requested_model

    async with inference_lock:
        if expected_model_key and expected_model_key != active_model_name:
            ok = await asyncio.to_thread(load_named_model, expected_model_key)
            if not ok:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"No se pudo activar el modelo '{requested_model}' en DirectML "
                        f"(modelo activo: '{active_model_name}')."
                    ),
                )

        input_tokens, max_length, resolved_active = await asyncio.to_thread(
            _prepare_tokens_sync,
            expected_model_key,
            req.messages,
            req.max_tokens,
        )

        if not req.stream:
            try:
                return await asyncio.to_thread(
                    run_generation_sync,
                    input_tokens,
                    max_length,
                    req.temperature,
                    req.top_p,
                )
            except Exception as e:
                print(f"[Inference Error] {e}")
                # La primera inferencia tras un cambio de modelo puede
                # resetear la GPU (0x887A0007); tras recuperar el MISMO
                # modelo, la segunda suele funcionar: reintentar una vez.
                await asyncio.to_thread(recover_device_if_needed, e)
                try:
                    input_tokens2, max_length2, _ = await asyncio.to_thread(
                        _prepare_tokens_sync,
                        expected_model_key,
                        req.messages,
                        req.max_tokens,
                    )
                    return await asyncio.to_thread(
                        run_generation_sync,
                        input_tokens2,
                        max_length2,
                        req.temperature,
                        req.top_p,
                    )
                except Exception as e2:
                    raise HTTPException(status_code=500, detail=f"DirectML inference error: {str(e2)}")

    return StreamingResponse(
        generate_stream_safe(
            request=request,
            expected_model_key=resolved_active,
            messages=req.messages,
            input_tokens=input_tokens,
            max_length=max_length,
            requested_max_tokens=req.max_tokens,
            temperature=req.temperature,
            top_p=req.top_p,
        ),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def wait_for_port_free(port: int = SERVER_PORT, host: str = SERVER_HOST, max_wait: int = 15) -> bool:
    for _ in range(max_wait):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((host, port))
                return True
            except OSError:
                time.sleep(1)
    return False


if __name__ == "__main__":
    while True:
        try:
            if not wait_for_port_free(SERVER_PORT, SERVER_HOST):
                print(f"[AVISO] El puerto {SERVER_PORT} sigue ocupado. Saliendo limpiamente.")
                sys.exit(0)
            print(f"Iniciando Uvicorn en http://{SERVER_HOST}:{SERVER_PORT}...")
            uvicorn.run(app, host=SERVER_HOST, port=SERVER_PORT, log_level="info")
            break
        except KeyboardInterrupt:
            print("Servidor detenido por el usuario.")
            break
        except Exception as ex:
            print(f"Uvicorn se detuvo con: {type(ex).__name__}: {ex}. Reiniciando servidor en 2 segundos...")
            import traceback

            traceback.print_exc()
            time.sleep(2)
