const http = require("node:http");
const https = require("node:https");
const envLoader = require("./env-loader.js");

const DEFAULT_FREEAI_BASE_URL = "https://api.free.ai/v1";

function getApiKeys() {
  envLoader.loadAllEnv();
  const candidates = [
    process.env.FREEAI_API_KEY_1,
    process.env.FREEAI_API_KEY_2,
    process.env.FREE_AI_API_KEY,
    process.env.FREEAI_API_KEY
  ];
  const seen = new Set();
  const keys = [];
  for (const raw of candidates) {
    if (!raw || typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    keys.push(trimmed);
  }
  return keys;
}

const API_KEYS = getApiKeys();

let currentKeyIndex = 0;

function getBaseUrl() {
  envLoader.loadAllEnv();
  const raw = process.env.FREEAI_BASE_URL;
  if (!raw || typeof raw !== "string") {
    return DEFAULT_FREEAI_BASE_URL;
  }
  const normalized = raw.trim().replace(/\/+$/, "");
  return normalized || DEFAULT_FREEAI_BASE_URL;
}

function getHttpClient(targetUrl) {
  const parsed = new URL(targetUrl);
  return {
    client: parsed.protocol === "http:" ? http : https,
    url: parsed
  };
}

function getKey() {
  const keys = getApiKeys();
  if (keys.length === 0) return "";
  return keys[currentKeyIndex % keys.length];
}

function rotateKey() {
  const keys = getApiKeys();
  if (keys.length > 1) {
    currentKeyIndex = (currentKeyIndex + 1) % keys.length;
    console.log(`[Free.ai] Clave rotada a índice ${currentKeyIndex}`);
  }
}

let cachedModels = null;
let cachedModelsBaseUrl = null;
let lastFetchTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

function fetchModels() {
  return new Promise((resolve, reject) => {
    const baseUrl = getBaseUrl();
    const now = Date.now();
    if (cachedModels && cachedModelsBaseUrl === baseUrl && (now - lastFetchTime) < CACHE_TTL) {
      return resolve(cachedModels);
    }

    const key = getKey();
    const targetUrl = `${baseUrl}/models`;
    const { client } = getHttpClient(targetUrl);

    const req = client.get(targetUrl, {
      headers: {
        "Authorization": `Bearer ${key}`,
        "User-Agent": "Antigravity/1.0"
      },
      timeout: 8000
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            rotateKey();
            return reject(new Error(`Free.ai API returned status ${res.statusCode}: ${data}`));
          }
          const parsed = JSON.parse(data);
          const rawModels = parsed.models || parsed.data || [];

          const formatted = rawModels.map((m) => {
            const rawId = m.id;
            const name = m.name || rawId;
            const type = m.type || "chat";
            return {
              id: "freeai:" + rawId,
              rawId,
              name: `${name} [Free.ai]`,
              type,
              provider: "Free.ai Cloud",
              license: m.license || "Free",
              pricing: m.pricing || null,
              isFreeAi: true
            };
          });

          cachedModels = formatted;
          cachedModelsBaseUrl = baseUrl;
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

function streamChat(payload, res, systemPrompt = null) {
  return new Promise((resolve, reject) => {
    const key = getKey();
    const baseUrl = getBaseUrl();
    const targetUrl = `${baseUrl}/chat/completions`;
    const { client } = getHttpClient(targetUrl);

    let model = payload.model || "qwen7b";
    if (model.startsWith("freeai:")) {
      model = model.replace("freeai:", "");
    }

    const messages = Array.isArray(payload.messages)
      ? payload.messages.map((m) => ({ ...m }))
      : [];

    if (systemPrompt) {
      if (messages.length > 0 && messages[0].role === "system") {
        messages[0].content = systemPrompt;
      } else {
        messages.unshift({ role: "system", content: systemPrompt });
      }
    }

    const bodyData = JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: payload.temperature !== undefined ? payload.temperature : 0.7,
      max_tokens: payload.max_tokens || 4096
    });

    const req = client.request(targetUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyData, "utf8"),
        "User-Agent": "Antigravity/1.0"
      },
      timeout: 45000
    }, (proxyRes) => {
      if (proxyRes.statusCode !== 200) {
        let errData = "";
        proxyRes.on("data", (c) => { errData += c; });
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
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;

          if (trimmed === "data: [DONE]") {
            res.write(JSON.stringify({
              model,
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
                res.write(JSON.stringify({
                  model,
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
  getBaseUrl,
  getApiKeys,
  API_KEYS
};
