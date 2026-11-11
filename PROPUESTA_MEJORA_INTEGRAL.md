# Local AI Studio — Propuesta de Mejora Integral v2

> Autor: **HUMAN AI SYNERGY BY Benner Castillo**
> Estado: **Fase 1 y 2 implementadas** · Interfaz v2 activa por defecto · Clásica preservada en `/classic`

---

## 1. Diagnóstico (qué encontramos)

| Área | Hallazgo |
|---|---|
| **Arquitectura** | Sólida: servidor Node sin dependencias, bridges por dominio (contexto, memoria, skills, Free.ai, integraciones, hardware, TTS) y 3 sidecars (Chat, Cline, Open WebUI). |
| **Interfaz** | `ui.html` de **12.334 líneas / 510 KB** en un solo archivo: difícil de mantener, lenta de parsear y con toda la lógica mezclada. |
| **Tests** | 62 ✅ / **17 ❌**: la mayoría no eran bugs de producto, sino **tests acoplados a la máquina del autor** (rutas `C:\Users\Benner\...`, skills instaladas, tokens reales, binarios de voz). Sin `package.json` no había forma estándar de correrlos. |
| **Portabilidad (bugs reales)** | ① `memory-store` calculaba el nombre del proyecto con `path.basename` del SO anfitrión → en Linux/macOS una ruta Windows devolvía la ruta completa. ② `context-bridge` no bloqueaba rutas absolutas Windows (`C:\Windows\...`) fuera de Windows. ③ `integrations-bridge` no reconocía `C:\` como raíz prohibida fuera de Windows. ④ `hf_downloader.py` importaba `huggingface_hub` al inicio: sin la librería **crashaba antes de validar argumentos** y sin emitir el error NDJSON esperado. ⑤ `ui_e2e.test.js` requería Playwright desde una ruta absoluta del autor. |
| **Robustez** | Omitir una prueba con `t.skip()` en tiempo de ejecución dejaba el proceso de test colgado (servidores de los hooks sin cerrar). |
| **Seguridad** | Buena base (sanitización de secretos, rutas protegidas, zero-trust en descargas), pero el servidor solo escuchaba en `127.0.0.1` sin opción de configuración. |

## 2. Qué se implementó

### 🎨 Nueva interfaz v2 (`sidecars/local_ai_chat/ui-v2.html`)
- **14 secciones navegables**: Chat, Modo Dual, Imagen, Voz/TTS, Proyectos y Contexto, Archivos y Editor, Skills, Memoria, Motores, Hardware, Integraciones, Descargas HF, Agentes y Ajustes/Diagnóstico.
- **Tema dual oscuro/claro** (persistente), acento violeta→cian, **logo e iconos reales** del proyecto, **splash screen** de arranque y **footer único** con la firma *HUMAN AI SYNERGY BY Benner CASTILLO*.
- **Responsive de verdad**: sidebar cajón ≤1280 px, panel de contexto solo en pantallas >1500 px, chat de borde a borde, blindaje anti-desborde de texto en toda la UI.
- **Conectada a la API real** (misma que usa la clásica): estado de Ollama/DirectML cada 30 s, catálogo unificado de modelos (`/api/tags`), proyecto activo y métricas de contexto, skills reales, historial de memoria, **chat con streaming real** (NDJSON/SSE) con botón Detener, y arranque/parada real de DirectML y reinicio de Ollama.
- Sin fingir datos: si un endpoint no responde, la UI lo dice con un toast.

### 🔀 Servidor (`sidecars/local_ai_chat/server.js`)
- `/` sirve la **v2**; `/classic` sirve siempre la interfaz anterior (rollback instantáneo).
- Host de escucha configurable con `LOCAL_AI_HOST` (defecto seguro: `127.0.0.1`).

### 🐛 Fallos corregidos
1. `memory-store.js` — `baseNameAnyPlatform()`: nombres de proyecto correctos con rutas de cualquier SO.
2. `context-bridge.js` — bloqueo de rutas absolutas Windows/UNC/POSIX en cualquier anfitrión.
3. `integrations-bridge.js` — `C:\` y `/` rechazados como destino de descarga en cualquier SO.
4. `hf_downloader.py` — import perezoso de `huggingface_hub`: primero valida y emite NDJSON; la librería solo se exige al descargar.
5. `tests/ui_e2e.test.js` — Playwright portable (`playwright` o `PLAYWRIGHT_PATH`) y suite omitida si no está.
6. Tests herméticos: las pruebas que exigen skills instaladas, binario `ollama`, voces Kokoro/Piper o red/credenciales se **omiten con motivo** (`skip` estático) en entornos sin esos recursos, y se ejecutan completas en la máquina del autor.

### ✅ Resultado de tests
| | Antes | Ahora |
|---|---|---|
| Pasan | 62 | **67** |
| Fallan | 17 | **0** |
| Omitidos (entorno) | 0 | 11 (con motivo) |

`npm test` ejecuta la batería completa; `npm run test:e2e` la de navegador.

## 3. Hoja de ruta propuesta (siguientes fases)

| Fase | Qué | Esfuerzo |
|---|---|---|
| **3 · Paridad total v2** | Cablear al 100% las vistas que hoy combinan datos reales y demo (Dual, Imagen, TTS con WAV real, Hardware con telemetría, Integraciones con acciones, editor con diff/rollback reales reutilizando los endpoints ya existentes). | Medio |
| **4 · Despiece del monolito** | Partir `ui.html`/`ui-v2.html` y `server.js` (5.137 líneas) en módulos por dominio manteniendo cero dependencias; la v2 ya nació con la capa de datos separada para facilitarlo. | Medio-alto |
| **5 · Instalador y CI** | `pip install huggingface_hub` guiado desde Diagnóstico, chequeo de primer arranque (puertos, rutas, claves) y workflow de CI que corra `npm test` en Windows + Linux. | Bajo-medio |
| **6 · Pulido UX** | Búsqueda global `Ctrl+K`, historial de chats clicable en v2, notificaciones de fin de respuesta y temas guardados por proyecto. | Bajo |

## 4. Cómo probar lo nuevo

```bash
npm start            # http://127.0.0.1:63719  → interfaz v2
                     # http://127.0.0.1:63719/classic → interfaz clásica
npm test             # 67 ✅ · 0 ❌ · 11 omitidos por entorno
```

En Antigravity no cambia nada operativo: el sidecar sigue arrancando igual y ahora muestra la v2; ante cualquier problema, `/classic` es el camino de vuelta inmediato.

## 5. Fuente oficial de Skills: antigravity-awesome-skills

- **Repo**: https://github.com/benjaminasterA/antigravity-awesome-skills (**889 skills** indexadas).
- La app lo detecta automáticamente si está clonado en `skills-repo/` (junto al proyecto) o en `vendor/antigravity-awesome-skills/`; la variable `LOCAL_AI_SKILLS_ROOT` sigue teniendo prioridad.
- Instalación/actualización: botón **⬇ Instalar / Actualizar** en *Agentes y Hubs* (endpoint `POST /api/skills/update`, clona/actualiza **solo** dentro de `skills-repo/`), o scripts `scripts/install-skills.ps1` (Windows) / `scripts/install-skills.sh`.
- Estado consultable en `GET /api/skills/source` (repo, instalado, nº de skills y categorías).
- Los **perfiles cognitivos** siguen leyéndose de tus carpetas locales de perfiles y de tus fusiones guardadas; el repo aporta el catálogo de skills (incluye rutas anidadas como `skills/game-development/2d-games/SKILL.md`).
- `skills-repo/` está en `.gitignore`: es un artefacto de instalación, no se versiona.
