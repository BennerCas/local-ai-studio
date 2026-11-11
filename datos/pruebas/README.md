# 🧪 Pruebas reales contra tus motores

Aquí **no hay simulación**: `scripts/prueba-real.js` llama a la API de verdad de tu
PC (Ollama, DirectML con Hermes-3-8B-UNLOCKED, Free.ai), mide tiempos y escribe
un informe con lo que respondió cada motor.

## Cómo ejecutarlo (en tu PC)

1. Arranca Local AI Studio como siempre (o deja que el probador lo arranque).
2. En la raíz del proyecto:
   - `npm run probar` → prueba completa (incluye que Hermes planifique un
     staff-json y generar una imagen FLUX pequeña; tarda varios minutos).
   - `npm run probar:rapido` → solo servidor, catálogo, motores y chats cortos.
3. Al terminar verás el resumen en consola y dos archivos aquí:
   `informe-<fecha>.md` y `informe-<fecha>.json`.

## Cómo trabajamos con el resultado

Comparte el `informe-*.md` en el chat de Arena (si el chat no acepta el archivo,
pégalo como texto o en base64 dentro de un .txt). Con ese informe reparo sobre
**fallos reales de tu máquina**, no sobre supuestos.

## Qué comprueba

Servidor · catálogo de modelos · que Hermes-3-8B-UNLOCKED esté en el catálogo ·
estado y arranque de DirectML · carga del Director · chat real con Hermes ·
chat con Ollama (si hay modelos) · chat con Free.ai (si hay red) · que el
Director devuelva un plan `staff-json` válido · generación de imagen FLUX ·
estado del TTS.
