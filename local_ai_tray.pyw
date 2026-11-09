import os
import sys
import time
import threading
import subprocess
import urllib.request
import webbrowser
from PIL import Image
import pystray
from pystray import MenuItem, Menu

BASE_DIR = r"C:\Users\Benner\.gemini\config\plugins\local-ai-studio"
SIDECAR_DIR = os.path.join(BASE_DIR, "sidecars", "local_ai_chat")
SERVER_JS = os.path.join(SIDECAR_DIR, "server.js")
DIRECTML_SCRIPT = r"C:\antigravityAS\Modelos -ai-brains\api_openai.py"
ICO_PATH = os.path.join(BASE_DIR, "tray_icon.ico")
PNG_PATH = os.path.join(BASE_DIR, "tray_icon.png")

APP_URL = "http://127.0.0.1:63719/"
DIRECTML_HEALTH = "http://127.0.0.1:8002/health"
OLLAMA_TAGS = "http://127.0.0.1:11434/api/tags"

server_proc = None
dml_proc = None

def is_url_alive(url, timeout=1.5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as res:
            return res.status in (200, 204)
    except Exception:
        return False

def start_server_js():
    global server_proc
    if is_url_alive(APP_URL):
        return
    env = dict(os.environ)
    env["ANTIGRAVITY_SIDECAR_WEB_PORT"] = "63719"
    server_proc = subprocess.Popen(
        ["node", SERVER_JS],
        cwd=SIDECAR_DIR,
        env=env,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    )

def start_directml():
    global dml_proc
    if is_url_alive(DIRECTML_HEALTH):
        return
    env = dict(os.environ)
    env["OLIVE_GPU_MEMORY_LIMIT"] = "25"
    env["OLIVE_CPU_THREADS"] = "12"
    env["ORT_DML_DEVICE_ID"] = "0"
    dml_proc = subprocess.Popen(
        [sys.executable, DIRECTML_SCRIPT],
        cwd=r"C:\antigravityAS\Modelos -ai-brains",
        env=env,
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    )

def ensure_services_running():
    start_server_js()
    start_directml()

def open_studio(icon=None, item=None):
    ensure_services_running()
    time.sleep(0.5)
    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    chrome_path = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    if os.path.exists(edge_path):
        subprocess.Popen([edge_path, f"--app={APP_URL}"])
    elif os.path.exists(chrome_path):
        subprocess.Popen([chrome_path, f"--app={APP_URL}"])
    else:
        webbrowser.open(APP_URL)

def open_project_folder(icon=None, item=None):
    folder = r"C:\antigravityAS\SynthIA"
    if os.path.exists(folder):
        os.startfile(folder)
    else:
        os.startfile(r"C:\antigravityAS")

def restart_services(icon=None, item=None):
    global server_proc, dml_proc
    try:
        if server_proc: server_proc.kill()
    except Exception: pass
    try:
        if dml_proc: dml_proc.kill()
    except Exception: pass
    server_proc = None
    dml_proc = None
    time.sleep(1)
    ensure_services_running()

def exit_action(icon, item):
    icon.stop()

def get_dml_status_text(item):
    return "⚡ DirectML GPU: Conectado (8002)" if is_url_alive(DIRECTML_HEALTH) else "⚡ DirectML GPU: Desconectado"

def get_ollama_status_text(item):
    return "🤖 Ollama: Activo (11434)" if is_url_alive(OLLAMA_TAGS) else "🤖 Ollama: Desconectado"

def setup_tray():
    ensure_services_running()
    img = Image.open(PNG_PATH) if os.path.exists(PNG_PATH) else None
    if img is None:
        img = Image.new("RGBA", (64, 64), color=(30, 40, 70, 255))

    menu = Menu(
        MenuItem("⚡ Abrir Local AI Studio", open_studio, default=True),
        MenuItem("📁 Abrir Carpeta de Proyectos", open_project_folder),
        Menu.SEPARATOR,
        MenuItem(get_dml_status_text, lambda icon, item: None, enabled=False),
        MenuItem(get_ollama_status_text, lambda icon, item: None, enabled=False),
        MenuItem("🔄 Reiniciar Servidores", restart_services),
        Menu.SEPARATOR,
        MenuItem("❌ Salir", exit_action)
    )

    icon = pystray.Icon("local_ai_studio", img, "Local AI Studio", menu)
    icon.run()

if __name__ == "__main__":
    setup_tray()
