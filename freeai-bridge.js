const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const https = require("node:https");
const envLoader = require("./env-loader.js");

const DEFAULT_FREEAI_BASE_URL = "https://api.free.ai/v1";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_PROMPT_LENGTH = 4000;
const DEFAULT_PROJECTS_ROOT = "C:\\antigravityAS";

const CONTROLNET_UNION_TYPES = Object.freeze([
  "scribble",
  "lineart",
  "canny",
  "depth",
  "pose",
  "anime-lineart",
  "mlsd",
  "hed",
  "soft-edge",
  "normal",
  "segmentation",
  "tile"
]);

/**
 * Catálogo curado 100% Sin Costo (self_hosted: true, costo $0 USD).
 * Queda estrictamente prohibido incluir modelos premium, Google Nano Banana, OpenAI GPT-5 Image o de terceros con costo.
 */
const FREE_SELF_HOSTED_IMAGE_MODELS = Object.freeze([
  // Generación Text-to-Image (mode: "generate", endpoint: "/image/generate/")
  Object.freeze({
    id: "flux2-klein",
    wireModel: "flux2-klein",
    name: "FLUX.2 Klein (4B)",
    mode: "generate",
    type: "image",
    endpoint: "/image/generate/",
    self_hosted: true,
    cost: 0,
    supportsNegativePrompt: true,
    supportsReferenceImage: false,
    badge: "Apache 2.0 · Ultra-Rápido · GEMINI.md",
    version: "4B",
    quantization: "FP8/INT8"
  }),
  Object.freeze({
    id: "qwen-image-2512",
    wireModel: "qwen-image-2512",
    name: "Qwen-Image 2512",
    mode: "generate",
    type: "image",
    endpoint: "/image/generate/",
    self_hosted: true,
    cost: 0,
    supportsNegativePrompt: true,
    supportsReferenceImage: false,
    badge: "Texto en Imagen · Fotorrealista",
    version: "2512",
    quantization: "BF16/INT8"
  }),
  Object.freeze({
    id: "sdxl",
    wireModel: "sdxl",
    name: "Stable Diffusion XL 1.0",
    mode: "generate",
    type: "image",
    endpoint: "/image/generate/",
    self_hosted: true,
    cost: 0,
    supportsNegativePrompt: true,
    supportsReferenceImage: true,
    badge: "IP-Adapter · Estilos",
    version: "1.0",
    quantization: "FP16"
  }),
  Object.freeze({
    id: "hidream-o1",
    wireModel: "hidream-o1",
    name: "HiDream-O1-Image (8B)",
    mode: "generate",
    type: "image",
    endpoint: "/image/generate/",
    self_hosted: true,
    cost: 0,
    supportsNegativePrompt: true,
    supportsReferenceImage: false,
    badge: "8B · Artístico",
    version: "8B",
    quantization: "BF16"
  }),

  // Boceto / Estructura -> Render estilo Vizcom (mode: "sketch", endpoint: "/image/generate/")
  Object.freeze({
    id: "controlnet-union-sdxl-promax",
    wireModel: "sdxl",
    name: "ControlNet-Union SDXL ProMax",
    mode: "sketch",
    type: "image",
    endpoint: "/image/generate/",
    self_hosted: true,
    cost: 0,
    supportsNegativePrompt: true,
    requiresControlImage: true,
    controlTypes: CONTROLNET_UNION_TYPES,
    defaultControlType: "scribble",
    defaultControlStrength: 0.75,
    badge: "Boceto → Render (12 modos)",
    version: "ProMax",
    quantization: "FP16"
  }),

  // Edición / Mejora / Segmentación (mode: "edit")
  Object.freeze({
    id: "qwen-image-edit",
    wireModel: "qwen-image-edit",
    name: "Qwen-Image-Edit 2511",
    mode: "edit",
    type: "image_edit",
    endpoint: "/image/edit/",
    operation: "img2img",
    self_hosted: true,
    cost: 0,
    requiresSourceImage: true,
    requiresPrompt: true,
    badge: "Edición Guiada por Texto",
    version: "2511",
    quantization: "BF16"
  }),
  Object.freeze({
    id: "step1x-edit",
    wireModel: "step1x-edit",
    name: "Step1X-Edit v1p2",
    mode: "edit",
    type: "image_edit",
    endpoint: "/image/edit/",
    operation: "img2img",
    self_hosted: true,
    cost: 0,
    requiresSourceImage: true,
    requiresPrompt: true,
    badge: "Edición Semántica",
    version: "v1p2",
    quantization: "BF16"
  }),
  Object.freeze({
    id: "sdxl-edit",
    wireModel: "sdxl",
    name: "SDXL Img2Img",
    mode: "edit",
    type: "image_edit",
    endpoint: "/image/edit/",
    operation: "img2img",
    self_hosted: true,
    cost: 0,
    requiresSourceImage: true,
    requiresPrompt: true,
    badge: "SDXL Img2Img",
    version: "1.0",
    quantization: "FP16"
  }),
  Object.freeze({
    id: "deoldify",
    wireModel: "deoldify",
    name: "DeOldify (Colorización)",
    mode: "edit",
    type: "image_edit",
    endpoint: "/image/edit/",
    operation: "img2img",
    self_hosted: true,
    cost: 0,
    requiresSourceImage: true,
    requiresPrompt: false,
    badge: "Restauración y Color",
    version: "1.0",
    quantization: "FP16"
  }),
  Object.freeze({
    id: "realesrgan",
    wireModel: "realesrgan",
    name: "Real-ESRGAN (Upscale 2x/4x)",
    mode: "edit",
    type: "image_enhance",
    endpoint: "/image/enhance/",
    self_hosted: true,
    cost: 0,
    requiresSourceImage: true,
    requiresPrompt: false,
    supportsScale: Object.freeze([2, 4]),
    badge: "Super-Resolución Sin Costo",
    version: "x4plus",
    quantization: "FP16"
  }),
  Object.freeze({
    id: "sam",
    wireModel: "sam",
    name: "Segment Anything (SAM)",
    mode: "edit",
    type: "image_segment",
    endpoint: "/image/segment/",
    self_hosted: true,
    cost: 0,
    requiresSourceImage: true,
    requiresPrompt: false,
    badge: "Segmentación de Objetos",
    version: "ViT-H",
    quantization: "FP16"
  })
]);

const FORBIDDEN_PAID_MODEL_PATTERNS = [
  /^premium\//i,
  /^google\//i,
  /^openai\//i,
  /^anthropic\//i,
  /^bfl\//i,
  /^stability\//i,
  /nano-banana/i,
  /gpt-5/i,
  /gpt-image/i,
  /dall-e/i,
  /imagen/i,
  /midjourney/i,
  /flux-pro/i,
  /flux-dev/i,
  /flux-ultra/i
];

function createHttpError(message, statusCode = 400, code = "BAD_REQUEST") {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function normalizeModelId(modelId) {
  if (!modelId || typeof modelId !== "string") return "";
  let clean = modelId.trim();
  if (clean.toLowerCase().startsWith("freeai:")) {
    clean = clean.slice(7).trim();
  }
  return clean.toLowerCase();
}

function isForbiddenPaidModelId(modelId) {
  const clean = normalizeModelId(modelId);
  if (!clean) return true;
  return FORBIDDEN_PAID_MODEL_PATTERNS.some((re) => re.test(clean));
}

/**
 * Guardia estricta Zero-Cost: rechaza con statusCode 400 y code PAID_MODEL_FORBIDDEN
 * cualquier modelo no incluido en FREE_SELF_HOSTED_IMAGE_MODELS o con patrón de pago.
 */
function assertZeroCostImageModel(modelId, expectedMode = null) {
  const clean = normalizeModelId(modelId);
  if (!clean || isForbiddenPaidModelId(clean)) {
    throw createHttpError(
      `Modelo bloqueado por política Zero-Cost: "${modelId || ""}". Solo se permiten modelos gratuitos self-hosted (self_hosted: true).`,
      400,
      "PAID_MODEL_FORBIDDEN"
    );
  }

  if (expectedMode === "edit" && clean === "sdxl") {
    const editSpec = FREE_SELF_HOSTED_IMAGE_MODELS.find((m) => m.id === "sdxl-edit");
    if (editSpec) return editSpec;
  }

  const found = FREE_SELF_HOSTED_IMAGE_MODELS.find((m) => m.id === clean);
  if (!found || found.self_hosted !== true || found.cost !== 0) {
    throw createHttpError(
      `Modelo bloqueado por política Zero-Cost: "${modelId}". Solo se permiten modelos gratuitos self-hosted (self_hosted: true).`,
      400,
      "PAID_MODEL_FORBIDDEN"
    );
  }

  return found;
}

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

          const filteredRaw = rawModels.filter((m) => {
            if (!m || !m.id) return false;
            const mType = String(m.type || "chat").toLowerCase();
            if (mType.startsWith("image")) {
              if (m.self_hosted === false) return false;
              if (isForbiddenPaidModelId(m.id)) return false;
            }
            return true;
          });

          const formatted = filteredRaw.map((m) => {
            const rawId = m.id;
            const name = m.name || rawId;
            const type = m.type || "chat";
            return {
              id: "freeai:" + rawId,
              rawId,
              name: `${name} [Free.ai]`,
              type,
              self_hosted: m.self_hosted !== undefined ? Boolean(m.self_hosted) : true,
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

/**
 * Consulta GET ${getBaseUrl()}/models (con fallback inmediato al catálogo local si está offline),
 * cruza disponibilidad en vivo con FREE_SELF_HOSTED_IMAGE_MODELS y filtra estrictamente cualquier
 * modelo con self_hosted === false o de pago.
 */
async function fetchImageCatalog() {
  const baseUrl = getBaseUrl();
  const key = getKey();
  const targetUrl = `${baseUrl}/models`;
  let remoteMap = new Map();
  let remoteReachable = false;

  try {
    const { client } = getHttpClient(targetUrl);
    const rawList = await new Promise((resolve, reject) => {
      const req = client.get(targetUrl, {
        headers: {
          ...(key ? { "Authorization": `Bearer ${key}` } : {}),
          "User-Agent": "Antigravity/1.0"
        },
        timeout: 6000
      }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          try {
            const parsed = JSON.parse(body);
            resolve(parsed.models || parsed.data || []);
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
    });

    if (Array.isArray(rawList)) {
      remoteReachable = true;
      for (const item of rawList) {
        if (!item || typeof item.id !== "string") continue;
        const cleanId = normalizeModelId(item.id);
        if (!cleanId) continue;
        // Bloquear modelos con self_hosted: false o patrones de pago
        if (item.self_hosted === false || isForbiddenPaidModelId(cleanId)) {
          continue;
        }
        const price = item.pricing && (Number(item.pricing.cost) || Number(item.pricing.per_image) || 0);
        if (price > 0) {
          continue;
        }
        remoteMap.set(cleanId, item);
      }
    }
  } catch (_err) {
    remoteReachable = false;
  }

  const models = FREE_SELF_HOSTED_IMAGE_MODELS.map((entry) => {
    const remote = remoteMap.get(entry.id) || remoteMap.get(entry.wireModel);
    return {
      ...entry,
      controlTypes: entry.controlTypes ? [...entry.controlTypes] : undefined,
      supportsScale: entry.supportsScale ? [...entry.supportsScale] : undefined,
      self_hosted: true,
      cost: 0,
      availableOnline: remoteReachable ? Boolean(remote || remoteMap.size === 0) : true
    };
  });

  return {
    ok: true,
    zeroCostOnly: true,
    remoteReachable,
    models
  };
}

/**
 * Decodifica data:image/(png|jpeg|webp);base64,... o base64 puro o Buffer.
 * Valida Magic Bytes reales (PNG, JPEG, WebP) y tamaño máximo <= 15 MB.
 */
function parseImageDataUrl(dataUrlOrBase64, fieldName = "image") {
  if (!dataUrlOrBase64) {
    throw createHttpError(`Imagen requerida en "${fieldName}".`, 400, "IMAGE_REQUIRED");
  }

  let buffer;
  let declaredMime = null;

  if (Buffer.isBuffer(dataUrlOrBase64)) {
    buffer = dataUrlOrBase64;
  } else if (typeof dataUrlOrBase64 === "string") {
    const trimmed = dataUrlOrBase64.trim();
    if (!trimmed) {
      throw createHttpError(`Imagen vacía en "${fieldName}".`, 400, "IMAGE_EMPTY");
    }

    if (trimmed.startsWith("data:")) {
      const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(trimmed);
      if (!match) {
        throw createHttpError(
          `Formato Data URL inválido en "${fieldName}". Se requiere data:image/(png|jpeg|webp);base64,...`,
          400,
          "INVALID_DATA_URL"
        );
      }
      declaredMime = match[1].toLowerCase().trim();
      if (
        declaredMime !== "image/png" &&
        declaredMime !== "image/jpeg" &&
        declaredMime !== "image/jpg" &&
        declaredMime !== "image/webp"
      ) {
        throw createHttpError(
          `MIME no permitido en "${fieldName}": ${declaredMime}. Solo se aceptan PNG, JPEG o WebP.`,
          400,
          "UNSUPPORTED_IMAGE_MIME"
        );
      }
      const b64Clean = match[2].replace(/\s+/g, "");
      buffer = Buffer.from(b64Clean, "base64");
    } else {
      const b64Clean = trimmed.replace(/\s+/g, "");
      if (!/^[A-Za-z0-9+/=_-]+$/.test(b64Clean)) {
        throw createHttpError(`Cadena Base64 inválida en "${fieldName}".`, 400, "INVALID_BASE64");
      }
      buffer = Buffer.from(b64Clean, "base64");
    }
  } else {
    throw createHttpError(`Tipo de imagen inválido en "${fieldName}".`, 400, "INVALID_IMAGE_TYPE");
  }

  if (!buffer || buffer.length < 12) {
    throw createHttpError(`Archivo de imagen corrupto o truncado en "${fieldName}".`, 400, "INVALID_IMAGE_MAGIC_BYTES");
  }

  if (buffer.length > MAX_IMAGE_BYTES) {
    throw createHttpError(
      `La imagen en "${fieldName}" excede el límite máximo de 15 MB (${buffer.length} bytes).`,
      400,
      "IMAGE_TOO_LARGE"
    );
  }

  // Verificación de Magic Bytes reales
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  const isPng =
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;

  // JPEG: FF D8 FF
  const isJpeg =
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff;

  // WebP: "RIFF" .... "WEBP" (52 49 46 46 ... 57 45 42 50)
  const isWebp =
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50;

  if (!isPng && !isJpeg && !isWebp) {
    throw createHttpError(
      `Magic Bytes inválidos en "${fieldName}". Solo se permiten binarios reales PNG, JPEG o WebP.`,
      400,
      "INVALID_IMAGE_MAGIC_BYTES"
    );
  }

  let mimeType = "image/png";
  let ext = "png";
  if (isJpeg) {
    mimeType = "image/jpeg";
    ext = "jpg";
  } else if (isWebp) {
    mimeType = "image/webp";
    ext = "webp";
  }

  const safeField = String(fieldName || "image").replace(/[^a-zA-Z0-9_-]/g, "") || "image";
  return {
    buffer,
    mimeType,
    ext,
    filename: `${safeField}.${ext}`,
    dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`
  };
}

/**
 * Construye un cuerpo multipart/form-data nativo con Buffer.concat (Zero-Bloat).
 */
function buildMultipartBody(fields = {}, files = []) {
  const boundary = `----AntigravityFreeAiBoundary${crypto.randomBytes(12).toString("hex")}`;
  const chunks = [];

  if (fields && typeof fields === "object") {
    for (const [key, val] of Object.entries(fields)) {
      if (val === undefined || val === null) continue;
      const safeKey = String(key).replace(/["\r\n]/g, "");
      const header =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${safeKey}"\r\n\r\n` +
        `${String(val)}\r\n`;
      chunks.push(Buffer.from(header, "utf8"));
    }
  }

  const normalizedFiles = [];
  if (Array.isArray(files)) {
    for (const f of files) {
      if (f && f.buffer) normalizedFiles.push(f);
    }
  } else if (files && typeof files === "object") {
    for (const [fieldName, fileVal] of Object.entries(files)) {
      if (!fileVal) continue;
      if (Buffer.isBuffer(fileVal) || typeof fileVal === "string") {
        const parsed = parseImageDataUrl(fileVal, fieldName);
        normalizedFiles.push({
          fieldName,
          filename: parsed.filename,
          mimeType: parsed.mimeType,
          buffer: parsed.buffer
        });
      } else if (Buffer.isBuffer(fileVal.buffer)) {
        normalizedFiles.push({
          fieldName: fileVal.fieldName || fieldName,
          filename: fileVal.filename || `${fieldName}.png`,
          mimeType: fileVal.mimeType || "application/octet-stream",
          buffer: fileVal.buffer
        });
      }
    }
  }

  for (const fileItem of normalizedFiles) {
    const safeField = String(fileItem.fieldName || "file").replace(/["\r\n]/g, "");
    const safeFilename = String(fileItem.filename || `${safeField}.png`).replace(/["\r\n]/g, "");
    const safeMime = String(fileItem.mimeType || "image/png").replace(/[\r\n]/g, "");
    const preamble =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${safeField}"; filename="${safeFilename}"\r\n` +
      `Content-Type: ${safeMime}\r\n\r\n`;
    chunks.push(Buffer.from(preamble, "utf8"));
    chunks.push(fileItem.buffer);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  const bodyBuffer = Buffer.concat(chunks);

  return {
    bodyBuffer,
    boundary,
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

function sendHttpRequest(targetUrl, { method = "GET", headers = {}, bodyBuffer = null, timeoutMs = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    let client;
    try {
      ({ client } = getHttpClient(targetUrl));
    } catch (err) {
      return reject(createHttpError(sanitizeFreeAiError(err), 400, "INVALID_URL"));
    }

    const key = getKey();
    const finalHeaders = {
      ...(key ? { "Authorization": `Bearer ${key}` } : {}),
      "User-Agent": "Antigravity/1.0",
      ...headers
    };
    if (bodyBuffer && finalHeaders["Content-Length"] === undefined) {
      finalHeaders["Content-Length"] = bodyBuffer.length;
    }

    const req = client.request(targetUrl, {
      method,
      headers: finalHeaders,
      timeout: timeoutMs
    }, (res) => {
      const chunks = [];
      let totalBytes = 0;

      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes <= MAX_IMAGE_BYTES * 2) {
          chunks.push(chunk);
        }
      });

      res.on("error", (err) => {
        rotateKey();
        reject(createHttpError(sanitizeFreeAiError(err), 502, "UPSTREAM_ERROR"));
      });

      res.on("end", () => {
        const rawBuffer = Buffer.concat(chunks);
        const contentType = String(res.headers["content-type"] || "").toLowerCase();

        if (res.statusCode < 200 || res.statusCode >= 300) {
          rotateKey();
          const errText = rawBuffer.toString("utf8");
          let parsedErrMsg = `Free.ai HTTP ${res.statusCode}`;
          try {
            const errJson = JSON.parse(errText);
            parsedErrMsg = errJson.error?.message || errJson.error || errJson.detail || errJson.message || errText;
          } catch (_e) {
            if (errText) parsedErrMsg = errText;
          }
          return reject(
            createHttpError(
              sanitizeFreeAiError(parsedErrMsg),
              res.statusCode === 400 ? 400 : 502,
              "FREEAI_HTTP_ERROR"
            )
          );
        }

        if (contentType.startsWith("image/")) {
          return resolve({
            isBinaryImage: true,
            statusCode: res.statusCode,
            contentType,
            buffer: rawBuffer
          });
        }

        const text = rawBuffer.toString("utf8");
        try {
          const json = JSON.parse(text);
          resolve({
            isBinaryImage: false,
            statusCode: res.statusCode,
            contentType,
            json
          });
        } catch (_e) {
          // Si no es JSON pero tiene Magic Bytes de imagen, tratar como binario
          try {
            parseImageDataUrl(rawBuffer, "response");
            return resolve({
              isBinaryImage: true,
              statusCode: res.statusCode,
              contentType: "image/png",
              buffer: rawBuffer
            });
          } catch (_magicErr) {
            reject(createHttpError(`Respuesta inválida de Free.ai: ${sanitizeFreeAiError(text.slice(0, 240))}`, 502, "INVALID_UPSTREAM_RESPONSE"));
          }
        }
      });
    });

    req.on("error", (err) => {
      rotateKey();
      reject(createHttpError(sanitizeFreeAiError(err), 502, "NETWORK_ERROR"));
    });

    req.on("timeout", () => {
      req.destroy();
      rotateKey();
      reject(createHttpError("Timeout esperando respuesta de imagen de Free.ai", 504, "UPSTREAM_TIMEOUT"));
    });

    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

function isQueuedResponse(resObj) {
  if (!resObj || resObj.isBinaryImage || !resObj.json) return false;
  const j = resObj.json;
  const status = String(j.status || "").toLowerCase();
  const hasJobId = Boolean(j.job_id || j.jobId || j.id);
  if (j.queued === true && hasJobId) return true;
  if ((status === "queued" || status === "processing" || status === "pending") && hasJobId) return true;
  return false;
}

/**
 * Consulta GET ${getBaseUrl()}/status/${encodeURIComponent(jobId)}/ periódicamente
 * hasta que el trabajo en cola termine o expire el timeout.
 */
async function pollImageJobStatus(jobId, options = {}) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) {
    throw createHttpError("job_id requerido para consultar estado de imagen.", 400, "MISSING_JOB_ID");
  }

  const intervalMs = Math.max(20, Number(options.intervalMs) || 2000);
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 120000);
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    const baseUrl = getBaseUrl();
    const statusUrl = `${baseUrl}/status/${encodeURIComponent(cleanJobId)}/`;
    const resObj = await sendHttpRequest(statusUrl, {
      method: "GET",
      timeoutMs: Math.min(30000, timeoutMs)
    });

    if (resObj.isBinaryImage) {
      return resObj;
    }

    const j = resObj.json || {};
    const status = String(j.status || "").toLowerCase();

    if (status === "failed" || status === "error" || status === "cancelled") {
      throw createHttpError(
        sanitizeFreeAiError(j.error || j.message || `El job ${cleanJobId} falló en Free.ai`),
        502,
        "JOB_FAILED"
      );
    }

    const hasImagePayload = Boolean(
      j.image ||
      j.image_base64 ||
      j.b64_json ||
      j.imageDataUrl ||
      j.image_url ||
      j.url ||
      j.output_url ||
      (Array.isArray(j.data) && j.data.length > 0) ||
      (Array.isArray(j.images) && j.images.length > 0) ||
      (j.result && (j.result.image || j.result.b64_json || j.result.url || j.result.image_url))
    );

    if (status === "completed" || status === "succeeded" || status === "done" || status === "success" || (!j.queued && hasImagePayload && status !== "queued" && status !== "processing" && status !== "pending")) {
      return resObj;
    }

    if (Date.now() - startedAt + intervalMs > timeoutMs) {
      break;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw createHttpError(
    `Timeout esperando finalización del job de imagen ${cleanJobId} en Free.ai`,
    504,
    "JOB_POLL_TIMEOUT"
  );
}

function normalizeImageResponse(resObj, { modelSpec, width, height, seed, startedAt }) {
  const elapsedMs = Math.max(1, Date.now() - startedAt);

  if (resObj.isBinaryImage && Buffer.isBuffer(resObj.buffer)) {
    const parsed = parseImageDataUrl(resObj.buffer, "output");
    return {
      ok: true,
      model: modelSpec.id,
      wireModel: modelSpec.wireModel || modelSpec.id,
      zeroCost: true,
      selfHosted: true,
      costUsd: 0,
      elapsedMs,
      imageDataUrl: parsed.dataUrl,
      imageUrl: null,
      mimeType: parsed.mimeType,
      width: width || 1024,
      height: height || 1024,
      seed: seed !== undefined && seed !== null ? Number(seed) : null,
      rawMeta: { statusCode: resObj.statusCode }
    };
  }

  const j = resObj.json || {};
  const inner = (j.result && typeof j.result === "object") ? j.result : j;
  const firstData = Array.isArray(inner.data) && inner.data[0] ? inner.data[0] : null;
  const firstImg = Array.isArray(inner.images) && inner.images[0] ? inner.images[0] : null;

  const rawBase64 =
    inner.imageDataUrl ||
    inner.image_data_url ||
    inner.image ||
    inner.image_base64 ||
    inner.b64_json ||
    (firstData && (firstData.b64_json || firstData.image || firstData.imageDataUrl)) ||
    (typeof firstImg === "string" ? firstImg : (firstImg && (firstImg.b64_json || firstImg.image || firstImg.url)));

  const rawUrl =
    inner.imageUrl ||
    inner.image_url ||
    inner.output_url ||
    inner.url ||
    (firstData && (firstData.url || firstData.image_url)) ||
    (firstImg && typeof firstImg === "object" && (firstImg.url || firstImg.image_url)) ||
    null;

  let imageDataUrl = null;
  let mimeType = inner.mimeType || inner.mime_type || "image/png";
  let imageUrl = rawUrl || null;

  if (typeof rawBase64 === "string" && rawBase64.trim()) {
    const trimmed = rawBase64.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      imageUrl = trimmed;
    } else {
      const parsed = parseImageDataUrl(trimmed, "output");
      imageDataUrl = parsed.dataUrl;
      mimeType = parsed.mimeType;
    }
  }

  if (!imageDataUrl && !imageUrl) {
    throw createHttpError(
      "Free.ai no devolvió ni imageDataUrl ni imageUrl válido en la respuesta.",
      502,
      "EMPTY_IMAGE_RESULT"
    );
  }

  const resolvedWidth = Number(inner.width || j.width || width || 1024);
  const resolvedHeight = Number(inner.height || j.height || height || 1024);
  const resolvedSeed =
    inner.seed !== undefined ? Number(inner.seed) :
    j.seed !== undefined ? Number(j.seed) :
    seed !== undefined && seed !== null && seed !== "" ? Number(seed) : null;

  return {
    ok: true,
    model: modelSpec.id,
    wireModel: modelSpec.wireModel || modelSpec.id,
    zeroCost: true,
    selfHosted: true,
    costUsd: 0,
    elapsedMs,
    imageDataUrl,
    imageUrl,
    mimeType,
    width: resolvedWidth,
    height: resolvedHeight,
    seed: resolvedSeed,
    rawMeta: {
      jobId: j.job_id || j.jobId || j.id || null,
      status: j.status || "completed"
    }
  };
}

function validatePrompt(prompt, required = true) {
  if (prompt === undefined || prompt === null || String(prompt).trim() === "") {
    if (required) {
      throw createHttpError("El prompt es obligatorio para generar o editar la imagen.", 400, "PROMPT_REQUIRED");
    }
    return "";
  }
  const clean = String(prompt).trim();
  if (clean.length > MAX_PROMPT_LENGTH) {
    throw createHttpError(
      `El prompt excede el máximo permitido de ${MAX_PROMPT_LENGTH} caracteres (${clean.length}).`,
      400,
      "PROMPT_TOO_LONG"
    );
  }
  return clean;
}

/**
 * Generación de imágenes 100% gratuita (Text-to-Image, Boceto->Render ControlNet-Union ProMax, SDXL IP-Adapter).
 */
async function generateImage(params = {}) {
  if (!params || typeof params !== "object") {
    throw createHttpError("Parámetros de generación inválidos.", 400, "INVALID_PARAMS");
  }

  const startedAt = Date.now();
  const requestedModel = params.model || "flux2-klein";
  const spec = assertZeroCostImageModel(requestedModel, "generate");

  if (spec.mode !== "generate" && spec.mode !== "sketch") {
    throw createHttpError(
      `El modelo "${spec.id}" pertenece al modo "${spec.mode}" y debe invocarse mediante editImage().`,
      400,
      "INVALID_MODEL_MODE"
    );
  }

  const prompt = validatePrompt(params.prompt, true);
  const negativePrompt = params.negative_prompt ?? params.negativePrompt
    ? validatePrompt(params.negative_prompt ?? params.negativePrompt, false)
    : "";

  const width = Math.min(2048, Math.max(256, Number(params.width) || 1024));
  const height = Math.min(2048, Math.max(256, Number(params.height) || 1024));
  const steps = Math.min(100, Math.max(1, Number(params.num_inference_steps ?? params.steps) || 25));
  const guidanceScale = Math.min(30, Math.max(0, Number(params.guidance_scale ?? params.cfg_scale ?? 7.5)));
  const hasSeed = params.seed !== undefined && params.seed !== null && params.seed !== "";
  const seed = hasSeed ? Number(params.seed) : undefined;

  const baseUrl = getBaseUrl();
  const targetUrl = `${baseUrl}/image/generate/`;

  const rawControlImage = params.controlImage || params.control_image || null;
  const rawReferenceImage = params.referenceImage || params.reference_image || null;

  let resObj;

  // Caso 1: ControlNet-Union SDXL ProMax (Boceto -> Render estilo Vizcom)
  if (spec.id === "controlnet-union-sdxl-promax" || rawControlImage) {
    if (!rawControlImage) {
      throw createHttpError(
        "El modelo controlnet-union-sdxl-promax requiere obligatoriamente controlImage (boceto o imagen guía).",
        400,
        "CONTROL_IMAGE_REQUIRED"
      );
    }

    const controlType = String(params.controlType || params.control_type || spec.defaultControlType || "scribble")
      .trim()
      .toLowerCase();

    if (!CONTROLNET_UNION_TYPES.includes(controlType)) {
      throw createHttpError(
        `controlType inválido: "${controlType}". Modos soportados: ${CONTROLNET_UNION_TYPES.join(", ")}`,
        400,
        "INVALID_CONTROL_TYPE"
      );
    }

    const rawStrength = params.controlStrength ?? params.control_strength ?? spec.defaultControlStrength ?? 0.75;
    const controlStrength = Number(rawStrength);
    if (!Number.isFinite(controlStrength) || controlStrength < 0.3 || controlStrength > 1.2) {
      throw createHttpError(
        `controlStrength inválido (${rawStrength}). Debe estar entre 0.3 y 1.2.`,
        400,
        "INVALID_CONTROL_STRENGTH"
      );
    }

    const parsedControl = parseImageDataUrl(rawControlImage, "control_image");
    const fields = {
      model: "sdxl", // Contrato real de Free.ai para controlnet-union-sdxl-promax
      prompt,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      width: String(width),
      height: String(height),
      num_inference_steps: String(steps),
      guidance_scale: String(guidanceScale),
      ...(seed !== undefined && Number.isFinite(seed) ? { seed: String(seed) } : {}),
      control_type: controlType,
      control_strength: String(controlStrength)
    };

    const multipart = buildMultipartBody(fields, [
      {
        fieldName: "control_image",
        filename: parsedControl.filename,
        mimeType: parsedControl.mimeType,
        buffer: parsedControl.buffer
      }
    ]);

    resObj = await sendHttpRequest(targetUrl, {
      method: "POST",
      headers: { "Content-Type": multipart.contentType },
      bodyBuffer: multipart.bodyBuffer
    });
  } else if (spec.id === "sdxl" && rawReferenceImage) {
    // Caso 2: SDXL con imagen de referencia (IP-Adapter)
    const rawScale = params.ipAdapterScale ?? params.ip_adapter_scale ?? 0.6;
    const ipAdapterScale = Number(rawScale);
    if (!Number.isFinite(ipAdapterScale) || ipAdapterScale < 0.1 || ipAdapterScale > 1.0) {
      throw createHttpError(
        `ip_adapter_scale inválido (${rawScale}). Debe estar entre 0.1 y 1.0.`,
        400,
        "INVALID_IP_ADAPTER_SCALE"
      );
    }

    const parsedRef = parseImageDataUrl(rawReferenceImage, "reference_image");
    const fields = {
      model: "sdxl",
      prompt,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      width: String(width),
      height: String(height),
      num_inference_steps: String(steps),
      guidance_scale: String(guidanceScale),
      ...(seed !== undefined && Number.isFinite(seed) ? { seed: String(seed) } : {}),
      ip_adapter_scale: String(ipAdapterScale)
    };

    const multipart = buildMultipartBody(fields, [
      {
        fieldName: "reference_image",
        filename: parsedRef.filename,
        mimeType: parsedRef.mimeType,
        buffer: parsedRef.buffer
      }
    ]);

    resObj = await sendHttpRequest(targetUrl, {
      method: "POST",
      headers: { "Content-Type": multipart.contentType },
      bodyBuffer: multipart.bodyBuffer
    });
  } else {
    // Caso 3: Text-to-Image puro en JSON (flux2-klein, qwen-image-2512, sdxl, hidream-o1)
    const jsonPayload = {
      model: spec.wireModel || spec.id,
      prompt,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      width,
      height,
      num_inference_steps: steps,
      guidance_scale: guidanceScale,
      ...(seed !== undefined && Number.isFinite(seed) ? { seed } : {}),
      ...(params.aspect_ratio || params.aspectRatio ? { aspect_ratio: params.aspect_ratio || params.aspectRatio } : {}),
      ...(params.style ? { style: String(params.style) } : {}),
      num_images: 1
    };

    const bodyBuffer = Buffer.from(JSON.stringify(jsonPayload), "utf8");
    resObj = await sendHttpRequest(targetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      bodyBuffer
    });
  }

  if (isQueuedResponse(resObj)) {
    const jobId = resObj.json.job_id || resObj.json.jobId || resObj.json.id;
    resObj = await pollImageJobStatus(jobId, params.pollOptions || {});
  }

  return normalizeImageResponse(resObj, {
    modelSpec: spec,
    width,
    height,
    seed,
    startedAt
  });
}

/**
 * Edición, mejora (Real-ESRGAN) y segmentación (SAM) de imágenes 100% sin costo.
 */
async function editImage(params = {}) {
  if (!params || typeof params !== "object") {
    throw createHttpError("Parámetros de edición inválidos.", 400, "INVALID_PARAMS");
  }

  const startedAt = Date.now();
  const requestedModel = params.model || "qwen-image-edit";
  const spec = assertZeroCostImageModel(requestedModel, "edit");

  const rawSourceImage = params.image || params.sourceImage || params.imageDataUrl || null;
  if (!rawSourceImage) {
    throw createHttpError("Se requiere la imagen base (params.image) para editar, escalar o segmentar.", 400, "SOURCE_IMAGE_REQUIRED");
  }

  const parsedImage = parseImageDataUrl(rawSourceImage, "image");
  const baseUrl = getBaseUrl();

  let targetUrl;
  let fields = {};

  if (spec.id === "realesrgan") {
    targetUrl = `${baseUrl}/image/enhance/`;
    const scale = Number(params.scale) === 2 ? 2 : 4;
    fields = {
      model: "realesrgan",
      scale: String(scale)
    };
  } else if (spec.id === "sam") {
    targetUrl = `${baseUrl}/image/segment/`;
    fields = {
      model: "sam",
      ...(params.prompt ? { prompt: validatePrompt(params.prompt, false) } : {})
    };
  } else if (
    spec.id === "qwen-image-edit" ||
    spec.id === "step1x-edit" ||
    spec.id === "sdxl-edit" ||
    spec.id === "sdxl" ||
    spec.id === "deoldify"
  ) {
    targetUrl = `${baseUrl}/image/edit/`;
    const promptRequired = spec.id !== "deoldify";
    const prompt = validatePrompt(params.prompt, promptRequired);
    const negativePrompt = params.negative_prompt ?? params.negativePrompt
      ? validatePrompt(params.negative_prompt ?? params.negativePrompt, false)
      : "";

    fields = {
      model: spec.wireModel || (spec.id === "sdxl-edit" ? "sdxl" : spec.id),
      operation: String(params.operation || spec.operation || "img2img"),
      ...(prompt ? { prompt } : {}),
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      ...(params.strength !== undefined && params.strength !== null ? { strength: String(Number(params.strength)) } : {}),
      ...(params.seed !== undefined && params.seed !== null && params.seed !== "" ? { seed: String(Number(params.seed)) } : {})
    };
  } else {
    throw createHttpError(
      `El modelo "${spec.id}" no soporta operaciones de edición/mejora.`,
      400,
      "UNSUPPORTED_EDIT_MODEL"
    );
  }

  const multipart = buildMultipartBody(fields, [
    {
      fieldName: "image",
      filename: parsedImage.filename,
      mimeType: parsedImage.mimeType,
      buffer: parsedImage.buffer
    }
  ]);

  let resObj = await sendHttpRequest(targetUrl, {
    method: "POST",
    headers: { "Content-Type": multipart.contentType },
    bodyBuffer: multipart.bodyBuffer
  });

  if (isQueuedResponse(resObj)) {
    const jobId = resObj.json.job_id || resObj.json.jobId || resObj.json.id;
    resObj = await pollImageJobStatus(jobId, params.pollOptions || {});
  }

  return normalizeImageResponse(resObj, {
    modelSpec: spec,
    width: Number(params.width) || 1024,
    height: Number(params.height) || 1024,
    seed: params.seed,
    startedAt
  });
}

function isPrivateOrLoopbackHost(hostname) {
  const h = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  const m172 = /^172\.(\d+)\./.exec(h);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Descarga de forma segura una imagen desde Free.ai validando anti-SSRF y Magic Bytes.
 */
async function fetchSafeImageBuffer(imageUrl) {
  if (!imageUrl || typeof imageUrl !== "string") {
    throw createHttpError("URL de imagen inválida.", 400, "INVALID_IMAGE_URL");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(imageUrl);
  } catch (_e) {
    throw createHttpError("URL de imagen malformada.", 400, "INVALID_IMAGE_URL");
  }

  const configuredBase = process.env.FREEAI_BASE_URL ? getBaseUrl() : null;
  let matchesTestBaseOrigin = false;
  if (configuredBase) {
    try {
      const baseParsed = new URL(configuredBase);
      matchesTestBaseOrigin =
        parsedUrl.protocol === baseParsed.protocol &&
        parsedUrl.host === baseParsed.host;
    } catch (_e) {
      matchesTestBaseOrigin = false;
    }
  }

  if (!matchesTestBaseOrigin) {
    if (parsedUrl.protocol !== "https:") {
      throw createHttpError("Solo se permiten descargas de imagen sobre HTTPS desde Free.ai.", 400, "SSRF_FORBIDDEN_PROTOCOL");
    }
    const host = parsedUrl.hostname.toLowerCase();
    const isAllowedFreeAiHost =
      host === "api.free.ai" ||
      host === "free.ai" ||
      host.endsWith(".free.ai");
    if (!isAllowedFreeAiHost || isPrivateOrLoopbackHost(host)) {
      throw createHttpError(`Origen de imagen bloqueado por política anti-SSRF: ${host}`, 400, "SSRF_FORBIDDEN_HOST");
    }
  }

  const resObj = await sendHttpRequest(parsedUrl.toString(), {
    method: "GET",
    timeoutMs: 30000
  });

  if (resObj.isBinaryImage && Buffer.isBuffer(resObj.buffer)) {
    return parseImageDataUrl(resObj.buffer, "downloaded_image");
  }

  if (resObj.json && (resObj.json.imageDataUrl || resObj.json.image || resObj.json.b64_json)) {
    return parseImageDataUrl(resObj.json.imageDataUrl || resObj.json.image || resObj.json.b64_json, "downloaded_image");
  }

  throw createHttpError("El recurso descargado no contiene un binario de imagen válido.", 400, "INVALID_DOWNLOADED_IMAGE");
}

function formatBibliotecaTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
}

function buildPromptSlug(prompt) {
  const raw = String(prompt || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!raw) return "render_ia";
  return raw.slice(0, 36).replace(/_+$/g, "") || "render_ia";
}

function assertSafeProjectPath(projectPath, allowedRootOption = null) {
  if (!projectPath || typeof projectPath !== "string") {
    throw createHttpError("projectPath es obligatorio para guardar en biblioteca/.", 400, "INVALID_PROJECT_PATH");
  }

  const allowedRootRaw =
    allowedRootOption ||
    process.env.LOCAL_AI_PROJECTS_DIR ||
    DEFAULT_PROJECTS_ROOT;

  if (!fs.existsSync(projectPath)) {
    throw createHttpError(`El directorio del proyecto no existe: ${projectPath}`, 400, "PROJECT_NOT_FOUND");
  }

  const realProject = fs.realpathSync(projectPath);
  const stat = fs.statSync(realProject);
  if (!stat.isDirectory()) {
    throw createHttpError("projectPath debe ser un directorio válido.", 400, "INVALID_PROJECT_PATH");
  }

  const realRoot = fs.existsSync(allowedRootRaw)
    ? fs.realpathSync(allowedRootRaw)
    : path.resolve(allowedRootRaw);

  const normProject = process.platform === "win32" ? realProject.toLowerCase() : realProject;
  const normRoot = process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
  const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;

  if (normProject !== normRoot && !normProject.startsWith(rootWithSep)) {
    throw createHttpError(
      `Acceso denegado: projectPath debe residir dentro de ${realRoot}`,
      400,
      "PROJECT_PATH_OUTSIDE_ROOT"
    );
  }

  return realProject;
}

/**
 * Persiste una imagen generada/editada y su archivo de metadatos JSON en <projectPath>/biblioteca/
 * cumpliendo estrictamente con ESTRUCTURA.md Secciones 2 y 3.
 */
async function saveImageToBiblioteca(options = {}) {
  const {
    projectPath,
    imageDataUrl,
    imageUrl,
    prompt = "",
    negativePrompt = "",
    model = "flux2-klein",
    params = {},
    metrics = {},
    sessionId = "local_ai_studio",
    allowedRoot = null
  } = options || {};

  const safeProjectDir = assertSafeProjectPath(projectPath, allowedRoot);
  const spec = assertZeroCostImageModel(model);

  let parsedImg;
  if (imageDataUrl) {
    parsedImg = parseImageDataUrl(imageDataUrl, "imageDataUrl");
  } else if (imageUrl) {
    parsedImg = await fetchSafeImageBuffer(imageUrl);
  } else {
    throw createHttpError("Se requiere imageDataUrl o imageUrl para guardar en biblioteca/.", 400, "IMAGE_REQUIRED");
  }

  const bibliotecaDir = path.join(safeProjectDir, "biblioteca");
  fs.mkdirSync(bibliotecaDir, { recursive: true });

  const now = new Date();
  const timestampToken = formatBibliotecaTimestamp(now);
  const slug = buildPromptSlug(prompt || spec.id);
  const baseName = `${timestampToken}_imagen_${slug}`;
  const imageFileName = `${baseName}.${parsedImg.ext}`;
  const metadataFileName = `${baseName}.json`;

  const imagePath = path.join(bibliotecaDir, imageFileName);
  const metadataPath = path.join(bibliotecaDir, metadataFileName);

  const width = Number(params.width) || 1024;
  const height = Number(params.height) || 1024;

  const metadata = {
    "Modelo Origen": {
      model: spec.id,
      wire_model: spec.wireModel || spec.id,
      name: spec.name,
      provider: "free.ai (self-hosted zero-cost)",
      self_hosted: true,
      version: spec.version || "1.0",
      quantization: spec.quantization || "FP16/INT8"
    },
    "Parámetros": {
      steps: Number(params.steps ?? params.num_inference_steps ?? 25),
      cfg_scale: Number(params.cfg_scale ?? params.guidance_scale ?? 7.5),
      seed: params.seed !== undefined && params.seed !== null && params.seed !== "" ? Number(params.seed) : null,
      sampler: params.sampler || "euler_discrete",
      resolution: `${width}x${height}`,
      control_type: params.control_type || params.controlType || null,
      control_strength: params.control_strength ?? params.controlStrength ?? null,
      operation: params.operation || spec.operation || spec.mode || "generate",
      scale: params.scale ? Number(params.scale) : null
    },
    "Prompt Original": {
      prompt: String(prompt || ""),
      negative_prompt: String(negativePrompt || params.negative_prompt || "")
    },
    "Métricas": {
      inference_time_ms: Number(metrics.inference_time_ms ?? metrics.elapsedMs ?? 0),
      cost_usd: 0,
      vram_local_mb: 0,
      tokens_input: Number(metrics.tokens_input ?? 0),
      tokens_output: Number(metrics.tokens_output ?? 0)
    },
    "Contexto": {
      app_version: "Local AI Studio 2.0",
      timestamp: now.toISOString(),
      user: process.env.USERNAME || process.env.USER || "local_user",
      session_id: String(sessionId || "local_ai_studio"),
      project_path: safeProjectDir,
      output_file: imageFileName
    }
  };

  fs.writeFileSync(imagePath, parsedImg.buffer);
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  return {
    ok: true,
    imagePath,
    metadataPath,
    fileName: imageFileName,
    metadataFileName,
    relativeImagePath: `biblioteca/${imageFileName}`,
    relativeMetadataPath: `biblioteca/${metadataFileName}`,
    bytes: parsedImg.buffer.length,
    mimeType: parsedImg.mimeType,
    metadata
  };
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
  FREE_SELF_HOSTED_IMAGE_MODELS,
  CONTROLNET_UNION_TYPES,
  assertZeroCostImageModel,
  fetchImageCatalog,
  parseImageDataUrl,
  buildMultipartBody,
  generateImage,
  editImage,
  pollImageJobStatus,
  fetchSafeImageBuffer,
  saveImageToBiblioteca,
  fetchModels,
  streamChat,
  getKey,
  rotateKey,
  getBaseUrl,
  getApiKeys,
  sanitizeFreeAiError,
  API_KEYS
};
