import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from PIL import Image
import pystray
from pystray import MenuItem, Menu

BASE_DIR = r"C:\Users\Benner\.gemini\config\plugins\local-ai-studio"
SIDECAR_DIR = os.path.join(BASE_DIR, "sidecars", "local_ai_chat")
SERVER_JS = os.path.join(SIDECAR_DIR, "server.js")
MODELS_DIR = r"C:\antigravityAS\Modelos -ai-brains"
DIRECTML_SCRIPT = os.path.join(MODELS_DIR, "api_openai.py")
PROJECTS_DIR = r"C:\antigravityAS\SynthIA"
PROJECTS_FALLBACK_DIR = r"C:\antigravityAS"
ICO_PATH = os.path.join(BASE_DIR, "tray_icon.ico")
PNG_PATH = os.path.join(BASE_DIR, "tray_icon.png")

APP_URL = "http://127.0.0.1:63719/"
DIRECTML_HEALTH = "http://127.0.0.1:8002/health"
OLLAMA_TAGS = "http://127.0.0.1:11434/api/tags"
POLL_INTERVAL_SECONDS = 5.0
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if sys.platform == "win32" else 0

server_proc = None
dml_proc = None

_status_cache = {
    "dml": False,
    "ollama": False,
    "app": False,
    "directml_model": None,
}
_status_lock = threading.Lock()
_service_op_lock = threading.Lock()
_stop_event = threading.Event()


def is_url_alive(url, timeout=1.5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as res:
            return res.status in (200, 204)
    except Exception:
        return False


def probe_directml_status(timeout=1.5):
    try:
        with urllib.request.urlopen(DIRECTML_HEALTH, timeout=timeout) as res:
            if res.status not in (200, 204):
                return False, None
            try:
                body = res.read().decode("utf-8", errors="ignore")
                if body:
                    data = json.loads(body)
                    if isinstance(data, dict):
                        model_name = data.get("model")
                        if data.get("model_loaded") and model_name and model_name != "Desconocido":
                            return True, str(model_name)
            except Exception:
                pass
            return True, None
    except Exception:
        return False, None


def _is_proc_running(proc):
    return proc is not None and proc.poll() is None


def start_server_js():
    global server_proc
    if _is_proc_running(server_proc) or is_url_alive(APP_URL):
        return
    env = dict(os.environ)
    env["ANTIGRAVITY_SIDECAR_WEB_PORT"] = "63719"
    server_proc = subprocess.Popen(
        ["node", SERVER_JS],
        cwd=SIDECAR_DIR,
        env=env,
        creationflags=CREATE_NO_WINDOW,
    )


def start_directml():
    global dml_proc
    if _is_proc_running(dml_proc) or is_url_alive(DIRECTML_HEALTH):
        return
    env = dict(os.environ)
    if not env.get("OLIVE_GPU_MEMORY_LIMIT"):
        env["OLIVE_GPU_MEMORY_LIMIT"] = "25"
    if not env.get("OLIVE_CPU_THREADS"):
        env["OLIVE_CPU_THREADS"] = "12"
    if not env.get("ORT_DML_DEVICE_ID"):
        env["ORT_DML_DEVICE_ID"] = "0"
    env["OLLAMA_IGPU_ENABLE"] = "1"
    if not env.get("HSA_OVERRIDE_GFX_VERSION"):
        env["HSA_OVERRIDE_GFX_VERSION"] = "11.0.0"

    dml_proc = subprocess.Popen(
        [sys.executable, DIRECTML_SCRIPT],
        cwd=MODELS_DIR,
        env=env,
        creationflags=CREATE_NO_WINDOW,
    )


def ensure_services_running():
    with _service_op_lock:
        start_server_js()
        start_directml()


def _terminate_managed_proc(proc):
    if proc is None:
        return
    try:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2.0)
            except Exception:
                proc.kill()
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def kill_existing_studio_processes(include_directml=True, include_server=False):
    global server_proc, dml_proc

    if include_server:
        _terminate_managed_proc(server_proc)
        server_proc = None

    if include_directml:
        _terminate_managed_proc(dml_proc)
        dml_proc = None

    if not include_directml and not include_server:
        return

    if sys.platform == "win32":
        match_clauses = []
        if include_directml:
            match_clauses.append(
                "((($name -like 'python*') -or ($name -like 'py*') -or ($name -like 'uvicorn*')) "
                "-and ($cmd -like '*api_openai.py*'))"
            )
        if include_server:
            match_clauses.append(
                "(($name -like 'node*') -and (($cmd -like '*sidecars\\local_ai_chat\\server.js*') "
                "-or ($cmd -like '*sidecars/local_ai_chat/server.js*')))"
            )

        condition = " -or ".join(match_clauses)
        ps_script = (
            "$selfPid = $PID; "
            f"$trayPid = {os.getpid()}; "
            "$procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue; "
            "if ($procs) { "
            "foreach ($p in $procs) { "
            "if (($p.ProcessId -eq $selfPid) -or ($p.ProcessId -eq $trayPid)) { continue }; "
            "$cmd = $p.CommandLine; "
            "if (-not $cmd) { continue }; "
            "$name = $p.Name; "
            "if (($name -like 'powershell*') -or ($name -like 'pwsh*')) { continue }; "
            f"if ({condition}) {{ Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }} "
            "} "
            "}"
        )
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps_script],
                creationflags=CREATE_NO_WINDOW,
                timeout=6,
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass


def refresh_status_cache(icon=None):
    app_alive = is_url_alive(APP_URL, timeout=1.2)
    dml_alive, dml_model = probe_directml_status(timeout=1.2)
    ollama_alive = is_url_alive(OLLAMA_TAGS, timeout=1.2)

    new_state = {
        "dml": dml_alive,
        "ollama": ollama_alive,
        "app": app_alive,
        "directml_model": dml_model,
    }

    with _status_lock:
        changed = new_state != _status_cache
        if changed:
            _status_cache.update(new_state)

    if changed and icon is not None:
        try:
            icon.update_menu()
        except Exception:
            pass

    return new_state


def _status_monitor_loop(icon):
    while not _stop_event.is_set():
        try:
            refresh_status_cache(icon)
        except Exception:
            pass
        if _stop_event.wait(POLL_INTERVAL_SECONDS):
            break


def _open_studio_worker(icon=None):
    ensure_services_running()
    if not is_url_alive(APP_URL, timeout=0.8):
        time.sleep(0.5)
    refresh_status_cache(icon)

    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    chrome_path = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    if os.path.exists(edge_path):
        subprocess.Popen([edge_path, f"--app={APP_URL}"])
    elif os.path.exists(chrome_path):
        subprocess.Popen([chrome_path, f"--app={APP_URL}"])
    else:
        webbrowser.open(APP_URL)


def open_studio(icon=None, item=None):
    threading.Thread(target=_open_studio_worker, args=(icon,), daemon=True).start()


def open_project_folder(icon=None, item=None):
    if os.path.exists(PROJECTS_DIR):
        os.startfile(PROJECTS_DIR)
    elif os.path.exists(PROJECTS_FALLBACK_DIR):
        os.startfile(PROJECTS_FALLBACK_DIR)


def open_models_folder(icon=None, item=None):
    if os.path.exists(MODELS_DIR):
        os.startfile(MODELS_DIR)
    elif os.path.exists(PROJECTS_FALLBACK_DIR):
        os.startfile(PROJECTS_FALLBACK_DIR)


def _stop_directml_worker(icon=None):
    with _service_op_lock:
        kill_existing_studio_processes(include_directml=True, include_server=False)
    refresh_status_cache(icon)


def stop_directml(icon=None, item=None):
    threading.Thread(target=_stop_directml_worker, args=(icon,), daemon=True).start()


def _restart_services_worker(icon=None):
    with _service_op_lock:
        kill_existing_studio_processes(include_directml=True, include_server=True)
        time.sleep(1.0)
        start_server_js()
        start_directml()
    refresh_status_cache(icon)


def restart_services(icon=None, item=None):
    threading.Thread(target=_restart_services_worker, args=(icon,), daemon=True).start()


def exit_action(icon, item=None):
    _stop_event.set()
    try:
        icon.visible = False
    except Exception:
        pass
    icon.stop()


def get_app_status_text(item=None):
    with _status_lock:
        alive = _status_cache["app"]
    return "🌐 App Studio: Activo (63719)" if alive else "🌐 App Studio: Desconectado"


def get_dml_status_text(item=None):
    with _status_lock:
        alive = _status_cache["dml"]
        model_name = _status_cache["directml_model"]
    if alive:
        if model_name:
            return f"⚡ DirectML GPU: Conectado (8002 · {model_name})"
        return "⚡ DirectML GPU: Conectado (8002)"
    return "⚡ DirectML GPU: Desconectado"


def get_ollama_status_text(item=None):
    with _status_lock:
        alive = _status_cache["ollama"]
    return "🤖 Ollama: Activo (11434)" if alive else "🤖 Ollama: Desconectado"


def _load_tray_image():
    for path in (PNG_PATH, ICO_PATH):
        if os.path.exists(path):
            try:
                with Image.open(path) as loaded:
                    return loaded.copy()
            except Exception:
                pass
    return Image.new("RGBA", (64, 64), color=(30, 40, 70, 255))


def _on_setup(icon):
    icon.visible = True
    threading.Thread(target=ensure_services_running, daemon=True).start()
    threading.Thread(target=_status_monitor_loop, args=(icon,), daemon=True).start()


def setup_tray():
    img = _load_tray_image()

    menu = Menu(
        MenuItem("⚡ Abrir Local AI Studio", open_studio, default=True),
        MenuItem("📁 Abrir Carpeta de Proyectos", open_project_folder),
        MenuItem("📂 Abrir Carpeta Central de Modelos", open_models_folder),
        Menu.SEPARATOR,
        MenuItem(get_app_status_text, lambda icon, item: None, enabled=False),
        MenuItem(get_dml_status_text, lambda icon, item: None, enabled=False),
        MenuItem(get_ollama_status_text, lambda icon, item: None, enabled=False),
        Menu.SEPARATOR,
        MenuItem("🛑 Detener DirectML (Liberar VRAM)", stop_directml),
        MenuItem("🔄 Reiniciar Servidores", restart_services),
        Menu.SEPARATOR,
        MenuItem("❌ Salir", exit_action),
    )

    icon = pystray.Icon("local_ai_studio", img, "Local AI Studio", menu)
    icon.run(setup=_on_setup)


if __name__ == "__main__":
    setup_tray()
