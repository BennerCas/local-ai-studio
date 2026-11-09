import sqlite3
import json
import sys
import os
import urllib.parse

APP_STORAGE = os.environ.get("LOCAL_AI_APP_STORAGE") or r"C:\Users\Benner\AppData\Roaming\Antigravity\app_storage.json"
if os.environ.get("LOCAL_AI_CONVERSATION_DB"):
    DB_PATH = os.environ.get("LOCAL_AI_CONVERSATION_DB")
elif os.environ.get("LOCAL_AI_BRAIN_DIR"):
    DB_PATH = ""
else:
    DB_PATH = r"C:\Users\Benner\.gemini\antigravity\conversation_summaries.db"
CONFIG_FILE = os.environ.get("LOCAL_AI_CONFIG_FILE") or r"C:\Users\Benner\.gemini\config\plugins\local-ai-studio\active_project.json"
BASE_PROJECTS_DIR = os.environ.get("LOCAL_AI_PROJECTS_DIR") or r"C:\antigravityAS"

def decode_uri(uris_raw):
    if not uris_raw:
        return "", ""
    try:
        uris = json.loads(uris_raw)
        if uris and uris[0].startswith("file:///"):
            raw = uris[0][8:]
            decoded = urllib.parse.unquote(raw)
            clean_path = decoded.replace("/", "\\")
            name = os.path.basename(clean_path.rstrip("\\"))
            return clean_path, name
    except Exception:
        pass
    return "", ""

def get_pinned_ids():
    pinned_ids = []
    if os.path.exists(APP_STORAGE):
        try:
            with open(APP_STORAGE, "r", encoding="utf-8") as f:
                app_data = json.load(f)
                pinned_ids = json.loads(app_data.get("pinned_conversations_order", "[]"))
        except Exception:
            pass
    return pinned_ids

def get_conversation_by_token(token):
    if not token or not os.path.exists(APP_STORAGE):
        return None
    try:
        with open(APP_STORAGE, "r", encoding="utf-8") as f:
            data = json.load(f)
        for key in ["aux-pane-v2-session", "aux-pane-session"]:
            raw = data.get(key)
            if not raw:
                continue
            session = json.loads(raw) if isinstance(raw, str) else raw
            panes = session.get("conversationPanes", {})
            for cid, pane in panes.items():
                for tab in pane.get("tabs", []):
                    sv = tab.get("content", {}).get("sidecarView", {})
                    url = sv.get("url", "")
                    if token in url:
                        return cid
    except Exception:
        pass
    return None

def get_sidebar_hierarchy():
    pinned = []
    projects_map = {}
    recent_convs = []
    con = None

    try:
        if DB_PATH and os.path.exists(DB_PATH):
            con = sqlite3.connect(DB_PATH)
            cur = con.cursor()
            pinned_ids = get_pinned_ids()

            # 1. Pinned Conversations
            for pid in pinned_ids:
                cur.execute("SELECT conversation_id, title, workspace_uris FROM conversation_summaries WHERE conversation_id = ?;", (pid,))
                r = cur.fetchone()
                if r and r[1] and r[1].strip():
                    p_path, p_name = decode_uri(r[2])
                    pinned.append({
                        "id": r[0],
                        "title": r[1].strip(),
                        "project": p_name or "General",
                        "path": p_path or BASE_PROJECTS_DIR
                    })

            # 2. Projects from DB
            cur.execute("""
                SELECT conversation_id, title, workspace_uris, project_id, last_modified_time
                FROM conversation_summaries
                WHERE workspace_uris IS NOT NULL AND workspace_uris != '' AND workspace_uris != '[]'
                ORDER BY last_modified_time DESC;
            """)
            all_proj_rows = cur.fetchall()

            for r in all_proj_rows:
                p_path, p_name = decode_uri(r[2])
                if not p_name or p_name.lower() in ["modelos -ai-brains", "modelos-ai-brains", "openwebui", "instalaciones", "restore-points"]:
                    continue

                if p_name not in projects_map:
                    projects_map[p_name] = {
                        "name": p_name,
                        "path": p_path,
                        "conversations": []
                    }

                if r[1] and r[1].strip() and r[0] not in pinned_ids:
                    if not any(c["id"] == r[0] for c in projects_map[p_name]["conversations"]):
                        projects_map[p_name]["conversations"].append({
                            "id": r[0],
                            "title": r[1].strip()
                        })

            # 3. Recent unpinned conversations
            cur.execute("""
                SELECT conversation_id, title, workspace_uris, last_modified_time
                FROM conversation_summaries
                WHERE title IS NOT NULL AND title != ''
                ORDER BY last_modified_time DESC
                LIMIT 40;
            """)
            seen_ids = set(pinned_ids)
            for r in cur.fetchall():
                if r[0] not in seen_ids and r[1] and r[1].strip():
                    seen_ids.add(r[0])
                    p_path, p_name = decode_uri(r[2])
                    recent_convs.append({
                        "id": r[0],
                        "title": r[1].strip(),
                        "project": p_name or "General",
                        "path": p_path or BASE_PROJECTS_DIR
                    })

        # Proyectos en disco (siempre incluir directorios reales en BASE_PROJECTS_DIR)
        if os.path.exists(BASE_PROJECTS_DIR):
            try:
                for entry in os.listdir(BASE_PROJECTS_DIR):
                    full = os.path.join(BASE_PROJECTS_DIR, entry)
                    if os.path.isdir(full) and not entry.startswith(".") and entry not in projects_map:
                        if entry.lower() not in ["modelos -ai-brains", "modelos-ai-brains", "openwebui", "instalaciones", "restore-points", ".vibecheck", "comfyui"]:
                            projects_map[entry] = {
                                "name": entry,
                                "path": full,
                                "conversations": []
                            }
            except Exception:
                pass

        projects_list = sorted(list(projects_map.values()), key=lambda x: x["name"].lower())

        return {
            "pinned": pinned,
            "projects": projects_list,
            "conversations": recent_convs
        }
    except Exception as e:
        return {"error": str(e), "pinned": [], "projects": [], "conversations": []}
    finally:
        if con is not None:
            try:
                con.close()
            except Exception:
                pass

def resolve(conv_id=None, token=None):
    cid = (conv_id or "").strip()
    
    # 1. Si no hay conv_id pero viene token, resolver conv_id desde app_storage.json
    if not cid and token:
        found_cid = get_conversation_by_token(token.strip())
        if found_cid:
            cid = found_cid

    # 2. Si tenemos conv_id, consultar base de datos
    if cid and os.path.exists(DB_PATH):
        try:
            con = sqlite3.connect(DB_PATH)
            cur = con.cursor()
            cur.execute("SELECT conversation_id, title, workspace_uris FROM conversation_summaries WHERE conversation_id = ?;", (cid,))
            row = cur.fetchone()
            if row:
                title = row[1] or ""
                p_path, p_name = decode_uri(row[2])
                
                if p_path and p_name:
                    return {
                        "convId": cid,
                        "title": title,
                        "projectPath": p_path,
                        "projectName": p_name,
                        "isGeneral": False
                    }
                else:
                    # Conversación General (sin workspace específico)
                    return {
                        "convId": cid,
                        "title": title or "Chat General",
                        "projectPath": BASE_PROJECTS_DIR,
                        "projectName": "General",
                        "isGeneral": True
                    }
        except Exception:
            pass

    # 3. Si no hay conv_id o no existe en DB, revisar active_project.json
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                act = cfg.get("activeProject")
                if act and act != "General":
                    act_path = os.path.join(BASE_PROJECTS_DIR, act)
                    if os.path.exists(act_path):
                        return {
                            "convId": cid,
                            "title": "",
                            "projectPath": act_path,
                            "projectName": act,
                            "isGeneral": False
                        }
        except Exception:
            pass

    # 4. Fallback estándar a Entorno General (NUNCA a SynthIA forzado)
    return {
        "convId": cid,
        "title": "General",
        "projectPath": BASE_PROJECTS_DIR,
        "projectName": "General",
        "isGeneral": True
    }

if __name__ == "__main__":
    arg1 = sys.argv[1] if len(sys.argv) > 1 else ""
    arg2 = sys.argv[2] if len(sys.argv) > 2 else ""

    if arg1 == "--hierarchy":
        print(json.dumps(get_sidebar_hierarchy(), ensure_ascii=False))
    elif arg1 == "--token":
        print(json.dumps(resolve(None, arg2), ensure_ascii=False))
    else:
        print(json.dumps(resolve(arg1, arg2), ensure_ascii=False))
