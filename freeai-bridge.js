const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");

// Load .env
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx !== -1) {
        const k = trimmed.slice(0, eqIdx).trim();
        const v = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[k]) {
          process.env[k] = v;
        }
      }
    }
  }
}
loadEnv();

const API_KEYS = [
  process.env.FREEAI_API_KEY_1,
  process.env.FREEAI_API_KEY_2
].filter(Boolean);

let currentKeyIndex = 0;

function getKey() {
  if (API_KEYS.length === 0) return "";
  return API_KEYS[currentKeyIndex % API_KEYS.length];
}

function rotateKey() {
  if (API_KEYS.length > 1) {
    currentKeyIndex = (currentKeyIndex + 1) % API_KEYS.length;
    console.log(`[Free.ai] Clave rotada a índice ${currentKeyIndex}`);
  }
}

let cachedModels = null;
let lastFetchTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

function fetchModels() {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    if (cachedModels && (now - lastFetchTime) < CACHE_TTL) {
      return resolve(cachedModels);
    }

    const key = getKey();
    const req = https.get("https://api.free.ai/v1/models", {
      headers: {
        "Authorization": `Bearer ${key}`,
        "User-Agent": "Antigravity/1.0"
      },
      timeout: 8000
    }, (res) => {
      let data = "";
      res.on("data", c => { data += c; });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            rotateKey();
            return reject(new Error(`Free.ai API returned status ${res.statusCode}: ${data}`));
          }
          const parsed = JSON.parse(data);
          const rawModels = parsed.models || [];
          
          // Categorizar y formatear
          const formatted = rawModels.map(m => {
            const rawId = m.id;
            const name = m.name || rawId;
            const type = m.type || "chat";
            return {
              id: "freeai:" + rawId,
              rawId: rawId,
              name: `${name} [Free.ai]`,
              type: type,
              provider: "Free.ai Cloud",
              license: m.license || "Free",
              pricing: m.pricing || null,
              isFreeAi: true
            };
          });

          cachedModels = formatted;
          lastFetchTime = now;
          resolve(formatted);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (err) => {
      rotateKey();
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      rotateKey();
      reject(new Error("Timeout conectando a Free.ai"));
    });
  });
}

// Streaming Chat Completion hacia Free.ai
function streamChat(payload, res, systemPrompt = null) {
  return new Promise((resolve, reject) => {
    const key = getKey();
    let model = payload.model || "qwen7b";
    if (model.startsWith("freeai:")) {
      model = model.replace("freeai:", "");
    }

    const messages = Array.isArray(payload.messages) ? [...payload.messages] : [];
    
    // Inyectar systemPrompt si existe
    if (systemPrompt) {
      if (messages.length > 0 && messages[0].role === "system") {
        messages[0].content = systemPrompt;
      } else {
        messages.unshift({ role: "system", content: systemPrompt });
      }
    }

    const bodyData = JSON.stringify({
      model: model,
      messages: messages,
      stream: true,
      temperature: payload.temperature !== undefined ? payload.temperature : 0.7,
      max_tokens: payload.max_tokens || 4096
    });

    const req = https.request("https://api.free.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "User-Agent": "Antigravity/1.0"
      },
      timeout: 45000
    }, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        let errData = "";
        proxyRes.on("data", c => { errData += c; });
        proxyRes.on("end", () => {
          rotateKey();
          if (!res.headersSent) {
            res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Free.ai error: " + errData }));
          }
          reject(new Error(errData));
        });
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*"
      });

      let buffer = "";

      proxyRes.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep remainder

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          if (trimmed === "data: [DONE]") {
            // Emite cierre compatible con Ollama
            res.write(JSON.stringify({
              model: model,
              message: { role: "assistant", content: "" },
              done: true
            }) + "\n");
            continue;
          }

          if (trimmed.startsWith("data: ")) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              const delta = data.choices && data.choices[0] && data.choices[0].delta;
              if (delta && delta.content) {
                // Emite formato compatible con el streaming que espera Local AI Studio y Cline
                res.write(JSON.stringify({
                  model: model,
                  message: { role: "assistant", content: delta.content },
                  done: false
                }) + "\n");
              }
            } catch (e) {}
          }
        }
      });

      proxyRes.on("end", () => {
        res.end();
        resolve();
      });
    });

    req.on("error", (err) => {
      rotateKey();
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Error conectando con Free.ai: " + err.message }));
      }
      reject(err);
    });

    req.on("timeout", () => {
      req.destroy();
      rotateKey();
      if (!res.headersSent) {
        res.writeHead(504, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Timeout en petición a Free.ai" }));
      }
      reject(new Error("Timeout en petición a Free.ai"));
    });

    req.write(bodyData);
    req.end();
  });
}

module.exports = {
  fetchModels,
  streamChat,
  getKey,
  rotateKey,
  API_KEYS
};
