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

function sanitizeFreeAiError(input, extraSecrets = []) {
  let text = "";
  if (input instanceof Error) {
    text = input.message || String(input);
  } else if (typeof input === "string") {
    text = input;
  } else if (input !== undefined && input !== null) {
    try {
      text = JSON.stringify(input);
    } catch (_e) {
      text = String(input);
    }
  }
  const secrets = [...getApiKeys(), ...(Array.isArray(extraSecrets) ? extraSecrets : [])]
    .filter((s) => typeof s === "string" && s.trim().length >= 4);
  for (const secret of secrets) {
    const clean = secret.trim();
    if (text.includes(clean)) {
      text = text.split(clean).join("[REDACTED]");
    }
  }
  text = text
    .replace(/(Bearer\s+)[^\s"',;]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:api_key|key|token)=)[^&\s"'#]+/gi, "$1[REDACTED]")
    .replace(/\bfreeai[_-][A-Za-z0-9_-]{6,}\b/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
  return text || "Error interno de Free.ai";
}

function getHttpClient(targetUrl) {
  const parsed = new URL(targetUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Protocolo no permitido para Free.ai: ${parsed.protocol}`);
  }
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
    let client;
    try {
      ({ client } = getHttpClient(targetUrl));
    } catch (urlErr) {
      return reject(new Error(sanitizeFreeAiError(urlErr)));
    }

    const req = client.get(targetUrl, {
      headers: {
        ...(key ? { "Authorization": `Bearer ${key}` } : {}),
        "User-Agent": "Antigravity/1.0"
      },
      timeout: 8000
    }, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("error", (err) => {
        rotateKey();
        reject(new Error(sanitizeFreeAiError(err)));
      });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            rotateKey();
            return reject(new Error(sanitizeFreeAiError(`Free.ai API returned status ${res.statusCode}: ${data}`)));
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
          reject(new Error(sanitizeFreeAiError(e)));
        }
      });
    });

    req.on("error", (err) => {
      rotateKey();
      reject(new Error(sanitizeFreeAiError(err)));
    });

    req.on("timeout", () => {
      req.destroy();
      rotateKey();
      reject(new Error("Timeout conectando a Free.ai"));
    });
  });
}

function streamChat(payload, res, systemPrompt = null, options = {}) {
  return new Promise((resolve, reject) => {
    const key = getKey();
    const baseUrl = getBaseUrl();
    const targetUrl = `${baseUrl}/chat/completions`;
    let client;
    try {
      ({ client } = getHttpClient(targetUrl));
    } catch (urlErr) {
      const safeMsg = sanitizeFreeAiError(urlErr);
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: safeMsg }));
      }
      return reject(new Error(safeMsg));
    }

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

    const signal = options && options.signal ? options.signal : null;
    let settled = false;
    let aborted = false;
    let req = null;
    let upstreamRes = null;

    function cleanup() {
      if (typeof res.off === "function") {
        res.off("close", onClientClose);
      } else if (typeof res.removeListener === "function") {
        res.removeListener("close", onClientClose);
      }
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onSignalAbort);
      }
    }

    function abortStream(reason = "Conexión cerrada por el cliente") {
      if (settled) return;
      aborted = true;
      settled = true;
      cleanup();
      try { if (upstreamRes) upstreamRes.destroy(); } catch (_e) {}
      try { if (req) req.destroy(); } catch (_e) {}
      const err = new Error(sanitizeFreeAiError(reason));
      err.aborted = true;
      reject(err);
    }

    function onClientClose() {
      if (!res.writableEnded) {
        abortStream("Conexión cerrada por el cliente");
      }
    }

    function onSignalAbort() {
      abortStream("Petición abortada por señal");
    }

    if (signal && signal.aborted) {
      return abortStream("Petición abortada por señal");
    }

    res.on("close", onClientClose);
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onSignalAbort, { once: true });
    }

    req = client.request(targetUrl, {
      method: "POST",
      headers: {
        ...(key ? { "Authorization": `Bearer ${key}` } : {}),
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(bodyData, "utf8"),
        "User-Agent": "Antigravity/1.0"
      },
      timeout: 45000
    }, (proxyRes) => {
      upstreamRes = proxyRes;
      if (aborted) {
        try { proxyRes.destroy(); } catch (_e) {}
        return;
      }

      if (proxyRes.statusCode !== 200) {
        let errData = "";
        proxyRes.on("data", (c) => { errData += c; });
        proxyRes.on("error", (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          const safeErr = sanitizeFreeAiError(err);
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: `Free.ai error: ${safeErr}` }));
          }
          reject(new Error(safeErr));
        });
        proxyRes.on("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          rotateKey();
          const safeErrData = sanitizeFreeAiError(errData);
          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(proxyRes.statusCode, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "Free.ai error: " + safeErrData }));
          }
          reject(new Error(safeErrData));
        });
        return;
      }

      const extraHeaders = (options && options.extraHeaders && typeof options.extraHeaders === "object")
        ? options.extraHeaders
        : {};
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(200, {
          ...extraHeaders,
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*"
        });
      }

      let buffer = "";

      function emitSseLine(rawLine) {
        if (aborted || res.writableEnded) return;
        const trimmed = String(rawLine || "").trim();
        if (!trimmed || trimmed.startsWith(":")) return;

        if (trimmed === "data: [DONE]") {
          res.write(JSON.stringify({
            model,
            message: { role: "assistant", content: "" },
            done: true
          }) + "\n");
          return;
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
          } catch (_e) {}
        }
      }

      proxyRes.on("data", (chunk) => {
        if (aborted || res.writableEnded) return;
        buffer += chunk.toString("utf-8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          emitSseLine(line);
        }
      });

      proxyRes.on("end", () => {
        if (settled) return;
        if (buffer.trim()) {
          emitSseLine(buffer);
          buffer = "";
        }
        settled = true;
        cleanup();
        if (!aborted && !res.writableEnded) {
          res.end();
        }
        resolve();
      });

      proxyRes.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        const safeErr = sanitizeFreeAiError(err);
        if (!res.writableEnded) {
          res.end();
        }
        reject(new Error(safeErr));
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      rotateKey();
      const safeErr = sanitizeFreeAiError(err);
      if (!aborted && !res.headersSent && !res.writableEnded) {
        res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Error conectando con Free.ai: " + safeErr }));
      } else if (!aborted && !res.writableEnded) {
        res.end();
      }
      reject(new Error(safeErr));
    });

    req.on("timeout", () => {
      if (settled) return;
      try { req.destroy(); } catch (_e) {}
      settled = true;
      cleanup();
      rotateKey();
      if (!aborted && !res.headersSent && !res.writableEnded) {
        res.writeHead(504, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Timeout en petición a Free.ai" }));
      } else if (!aborted && !res.writableEnded) {
        res.end();
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
  sanitizeFreeAiError,
  API_KEYS
};
