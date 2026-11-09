const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const freeaiBridge = require("../freeai-bridge.js");

// 1x1 PNG transparente válido (Magic Bytes: 89 50 4E 47 0D 0A 1A 0A)
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const VALID_PNG_DATA_URL = `data:image/png;base64,${VALID_PNG_BASE64}`;
const VALID_PNG_BUFFER = Buffer.from(VALID_PNG_BASE64, "base64");

// JPEG mínimo válido (Magic Bytes: FF D8 FF E0 ...)
const VALID_JPEG_BUFFER = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48,
  0x00, 0x48, 0x00, 0x00, 0xff, 0xd9
]);
const VALID_JPEG_DATA_URL = `data:image/jpeg;base64,${VALID_JPEG_BUFFER.toString("base64")}`;

// WebP mínimo válido (Magic Bytes: "RIFF" + size + "WEBP" + "VP8 ")
const VALID_WEBP_BUFFER = Buffer.from([
  0x52, 0x49, 0x46, 0x46, 0x14, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
  0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
]);
const VALID_WEBP_DATA_URL = `data:image/webp;base64,${VALID_WEBP_BUFFER.toString("base64")}`;

function listenServer(srv) {
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      resolve(srv.address().port);
    });
  });
}

function closeServer(srv) {
  return new Promise((resolve) => {
    if (!srv || !srv.listening) return resolve();
    srv.close(() => resolve());
  });
}

describe("Free.ai Zero-Cost Image Studio Bridge (Bloque 2)", () => {
  let mockServer = null;
  let mockPort = 0;
  let capturedRequests = [];
  let customRouteHandler = null;
  let tempRoot = "";
  let savedBaseUrl = undefined;
  let savedKey1 = undefined;

  beforeEach(async () => {
    savedBaseUrl = process.env.FREEAI_BASE_URL;
    savedKey1 = process.env.FREEAI_API_KEY_1;
    capturedRequests = [];
    customRouteHandler = null;

    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freeai-img-test-"));

    mockServer = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks);
        const contentType = String(req.headers["content-type"] || "");
        let parsedJson = null;
        if (contentType.includes("application/json")) {
          try {
            parsedJson = JSON.parse(rawBody.toString("utf8"));
          } catch (_e) {}
        }

        const record = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          contentType,
          rawBody,
          rawText: rawBody.toString("latin1"),
          json: parsedJson
        };
        capturedRequests.push(record);

        if (typeof customRouteHandler === "function") {
          const handled = customRouteHandler(record, res);
          if (handled !== false) return;
        }

        if (req.method === "GET" && req.url === "/v1/models") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            models: [
              { id: "flux2-klein", type: "image", self_hosted: true },
              { id: "controlnet-union-sdxl-promax", type: "image", self_hosted: true },
              { id: "google/gemini-nano-banana-2.1", type: "image", self_hosted: false, pricing: { cost: 0.05 } },
              { id: "openai/gpt-5-image", type: "image", self_hosted: false, pricing: { cost: 0.08 } }
            ]
          }));
          return;
        }

        if (req.method === "GET" && req.url === "/v1/assets/render_out.png") {
          res.writeHead(200, { "Content-Type": "image/png" });
          res.end(VALID_PNG_BUFFER);
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          b64_json: VALID_PNG_BASE64,
          width: 1024,
          height: 1024,
          seed: 42
        }));
      });
    });

    mockPort = await listenServer(mockServer);
    process.env.FREEAI_BASE_URL = `http://127.0.0.1:${mockPort}/v1`;
    process.env.FREEAI_API_KEY_1 = "freeai_test_mock_key_zero_cost";
  });

  afterEach(async () => {
    await closeServer(mockServer);
    if (savedBaseUrl === undefined) {
      delete process.env.FREEAI_BASE_URL;
    } else {
      process.env.FREEAI_BASE_URL = savedBaseUrl;
    }
    if (savedKey1 === undefined) {
      delete process.env.FREEAI_API_KEY_1;
    } else {
      process.env.FREEAI_API_KEY_1 = savedKey1;
    }
    if (tempRoot && fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("1. assertZeroCostImageModel permite únicamente modelos self_hosted: true y bloquea cualquier modelo de pago con statusCode 400", async () => {
    const allowedIds = [
      "flux2-klein",
      "controlnet-union-sdxl-promax",
      "qwen-image-2512",
      "qwen-image-edit",
      "sdxl",
      "sdxl-edit",
      "hidream-o1",
      "step1x-edit",
      "deoldify",
      "realesrgan",
      "sam",
      "freeai:flux2-klein"
    ];

    for (const id of allowedIds) {
      const spec = freeaiBridge.assertZeroCostImageModel(id);
      assert.ok(spec, `Debió permitir el modelo gratuito ${id}`);
      assert.equal(spec.self_hosted, true);
      assert.equal(spec.cost, 0);
    }

    const forbiddenPaidIds = [
      "google/gemini-nano-banana-2.1",
      "nano-banana",
      "openai/gpt-5-image",
      "gpt-5-image",
      "premium/flux-pro",
      "bfl/flux-dev",
      "dall-e-3",
      "midjourney-v6",
      "modelo-inexistente-pago",
      ""
    ];

    for (const badId of forbiddenPaidIds) {
      assert.throws(
        () => freeaiBridge.assertZeroCostImageModel(badId),
        (err) => {
          assert.equal(err.statusCode, 400);
          assert.equal(err.code, "PAID_MODEL_FORBIDDEN");
          return true;
        },
        `Debió rechazar el modelo de pago o no autorizado: "${badId}"`
      );
    }

    const catalog = await freeaiBridge.fetchImageCatalog();
    assert.equal(catalog.ok, true);
    assert.equal(catalog.zeroCostOnly, true);
    assert.ok(Array.isArray(catalog.models));
    assert.ok(catalog.models.length >= 10);
    for (const m of catalog.models) {
      assert.equal(m.self_hosted, true);
      assert.equal(m.cost, 0);
      assert.equal(/nano-banana|gpt-5|premium/i.test(m.id), false);
    }
  });

  it("2. generateImage soporta flux2-klein (JSON) y controlnet-union-sdxl-promax (multipart/form-data con model: 'sdxl', control_type y control_image)", async () => {
    // 2.1 Generación JSON con flux2-klein
    const genRes = await freeaiBridge.generateImage({
      model: "flux2-klein",
      prompt: "Arquitectura cyberpunk con luces de neón en lluvia",
      negativePrompt: "borroso, baja calidad",
      width: 1024,
      height: 1024,
      steps: 20,
      guidance_scale: 7.0,
      seed: 777
    });

    assert.equal(genRes.ok, true);
    assert.equal(genRes.model, "flux2-klein");
    assert.equal(genRes.zeroCost, true);
    assert.ok(genRes.imageDataUrl.startsWith("data:image/png;base64,"));

    const fluxReq = capturedRequests.find((r) => r.url === "/v1/image/generate/");
    assert.ok(fluxReq, "Debió enviar POST a /v1/image/generate/");
    assert.ok(fluxReq.contentType.includes("application/json"));
    assert.equal(fluxReq.json.model, "flux2-klein");
    assert.equal(fluxReq.json.prompt, "Arquitectura cyberpunk con luces de neón en lluvia");
    assert.equal(fluxReq.json.negative_prompt, "borroso, baja calidad");
    assert.equal(fluxReq.json.num_images, 1);
    assert.equal(fluxReq.json.seed, 777);

    // 2.2 Boceto -> Render con controlnet-union-sdxl-promax (multipart/form-data)
    capturedRequests = [];
    const sketchRes = await freeaiBridge.generateImage({
      model: "controlnet-union-sdxl-promax",
      prompt: "Automóvil deportivo conceptual renderizado en estudio",
      controlImage: VALID_PNG_DATA_URL,
      controlType: "scribble",
      controlStrength: 0.8
    });

    assert.equal(sketchRes.ok, true);
    assert.equal(sketchRes.model, "controlnet-union-sdxl-promax");
    assert.equal(sketchRes.wireModel, "sdxl");
    assert.equal(sketchRes.zeroCost, true);

    const cnReq = capturedRequests.find((r) => r.url === "/v1/image/generate/");
    assert.ok(cnReq, "Debió enviar POST multipart a /v1/image/generate/");
    assert.ok(cnReq.contentType.startsWith("multipart/form-data; boundary="));
    assert.match(cnReq.rawText, /name="model"\r\n\r\nsdxl\r\n/);
    assert.match(cnReq.rawText, /name="control_type"\r\n\r\nscribble\r\n/);
    assert.match(cnReq.rawText, /name="control_strength"\r\n\r\n0\.8\r\n/);
    assert.match(cnReq.rawText, /name="control_image"; filename="control_image\.png"/);

    // 2.3 Bloqueo de modelos de pago en generateImage
    await assert.rejects(
      () => freeaiBridge.generateImage({
        model: "google/gemini-nano-banana-2.1",
        prompt: "Intento con modelo de pago"
      }),
      (err) => err.statusCode === 400 && err.code === "PAID_MODEL_FORBIDDEN"
    );
  });

  it("3. editImage soporta qwen-image-edit (/image/edit/ con operation: img2img), realesrgan (/image/enhance/) y sam (/image/segment/)", async () => {
    // 3.1 qwen-image-edit
    const editRes = await freeaiBridge.editImage({
      model: "qwen-image-edit",
      image: VALID_PNG_DATA_URL,
      prompt: "Cambiar el cielo a atardecer dorado"
    });
    assert.equal(editRes.ok, true);
    assert.equal(editRes.model, "qwen-image-edit");
    assert.equal(editRes.zeroCost, true);

    const qwenEditReq = capturedRequests.find((r) => r.url === "/v1/image/edit/");
    assert.ok(qwenEditReq, "Debió invocar /v1/image/edit/");
    assert.ok(qwenEditReq.contentType.startsWith("multipart/form-data; boundary="));
    assert.match(qwenEditReq.rawText, /name="model"\r\n\r\nqwen-image-edit\r\n/);
    assert.match(qwenEditReq.rawText, /name="operation"\r\n\r\nimg2img\r\n/);
    assert.match(qwenEditReq.rawText, /name="prompt"\r\n\r\nCambiar el cielo a atardecer dorado\r\n/);
    assert.match(qwenEditReq.rawText, /name="image"; filename="image\.png"/);

    // 3.2 realesrgan
    capturedRequests = [];
    const enhanceRes = await freeaiBridge.editImage({
      model: "realesrgan",
      image: VALID_JPEG_DATA_URL,
      scale: 4
    });
    assert.equal(enhanceRes.ok, true);
    assert.equal(enhanceRes.model, "realesrgan");

    const esrganReq = capturedRequests.find((r) => r.url === "/v1/image/enhance/");
    assert.ok(esrganReq, "Debió invocar /v1/image/enhance/");
    assert.match(esrganReq.rawText, /name="model"\r\n\r\nrealesrgan\r\n/);
    assert.match(esrganReq.rawText, /name="scale"\r\n\r\n4\r\n/);
    assert.match(esrganReq.rawText, /name="image"; filename="image\.jpg"/);

    // 3.3 sam
    capturedRequests = [];
    const samRes = await freeaiBridge.editImage({
      model: "sam",
      image: VALID_WEBP_DATA_URL
    });
    assert.equal(samRes.ok, true);
    assert.equal(samRes.model, "sam");

    const samReq = capturedRequests.find((r) => r.url === "/v1/image/segment/");
    assert.ok(samReq, "Debió invocar /v1/image/segment/");
    assert.match(samReq.rawText, /name="model"\r\n\r\nsam\r\n/);
    assert.match(samReq.rawText, /name="image"; filename="image\.webp"/);
  });

  it("4. pollImageJobStatus resuelve trabajos en cola cuando el endpoint devuelve { queued: true, job_id }", async () => {
    let statusCalls = 0;
    customRouteHandler = (record, res) => {
      if (record.method === "POST" && record.url === "/v1/image/generate/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          queued: true,
          status: "queued",
          job_id: "job_async_999"
        }));
        return true;
      }
      if (record.method === "GET" && record.url === "/v1/status/job_async_999/") {
        statusCalls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        if (statusCalls < 2) {
          res.end(JSON.stringify({
            queued: true,
            status: "processing",
            job_id: "job_async_999"
          }));
        } else {
          res.end(JSON.stringify({
            queued: false,
            status: "completed",
            job_id: "job_async_999",
            b64_json: VALID_PNG_BASE64,
            seed: 12345
          }));
        }
        return true;
      }
      return false;
    };

    const result = await freeaiBridge.generateImage({
      model: "qwen-image-2512",
      prompt: " Cartel tipográfico futurista ",
      pollOptions: { intervalMs: 30, timeoutMs: 3000 }
    });

    assert.equal(result.ok, true);
    assert.equal(result.model, "qwen-image-2512");
    assert.equal(result.seed, 12345);
    assert.ok(statusCalls >= 2, "Debió consultar /v1/status/job_async_999/ al menos 2 veces");
    assert.ok(result.imageDataUrl.startsWith("data:image/png;base64,"));
  });

  it("5. valida Magic Bytes reales en parseImageDataUrl y guarda imagen + metadata JSON en biblioteca/ según ESTRUCTURA.md", async () => {
    // 5.1 PNG, JPEG y WebP válidos pasan
    const pngParsed = freeaiBridge.parseImageDataUrl(VALID_PNG_DATA_URL);
    assert.equal(pngParsed.mimeType, "image/png");
    assert.equal(pngParsed.ext, "png");

    const jpgParsed = freeaiBridge.parseImageDataUrl(VALID_JPEG_DATA_URL);
    assert.equal(jpgParsed.mimeType, "image/jpeg");
    assert.equal(jpgParsed.ext, "jpg");

    const webpParsed = freeaiBridge.parseImageDataUrl(VALID_WEBP_DATA_URL);
    assert.equal(webpParsed.mimeType, "image/webp");
    assert.equal(webpParsed.ext, "webp");

    // 5.2 SVG/HTML malicioso disfrazado de PNG debe ser rechazado con 400
    const fakeSvgB64 = Buffer.from("<svg onload=alert(1)></svg>", "utf8").toString("base64");
    assert.throws(
      () => freeaiBridge.parseImageDataUrl(`data:image/png;base64,${fakeSvgB64}`),
      (err) => err.statusCode === 400 && err.code === "INVALID_IMAGE_MAGIC_BYTES"
    );

    // 5.3 Guardado en <projectPath>/biblioteca/ cumpliendo ESTRUCTURA.md
    const projectDir = path.join(tempRoot, "MiProyectoVisual");
    fs.mkdirSync(projectDir, { recursive: true });

    const saved = await freeaiBridge.saveImageToBiblioteca({
      projectPath: projectDir,
      allowedRoot: tempRoot,
      imageDataUrl: VALID_PNG_DATA_URL,
      prompt: "Retrato Cyberpunk Neón 2099!",
      negativePrompt: "baja calidad, deformado",
      model: "flux2-klein",
      params: {
        steps: 28,
        cfg_scale: 7.5,
        seed: 2099,
        width: 1024,
        height: 1024
      },
      metrics: {
        inference_time_ms: 840
      },
      sessionId: "sess_test_01"
    });

    assert.equal(saved.ok, true);
    assert.match(saved.fileName, /^\d{8}_\d{6}_imagen_retrato_cyberpunk_neon_2099\.png$/);
    assert.match(saved.metadataFileName, /^\d{8}_\d{6}_imagen_retrato_cyberpunk_neon_2099\.json$/);
    assert.equal(fs.existsSync(saved.imagePath), true);
    assert.equal(fs.existsSync(saved.metadataPath), true);

    const diskMeta = JSON.parse(fs.readFileSync(saved.metadataPath, "utf8"));
    assert.equal(diskMeta["Modelo Origen"].model, "flux2-klein");
    assert.equal(diskMeta["Modelo Origen"].self_hosted, true);
    assert.equal(diskMeta["Parámetros"].steps, 28);
    assert.equal(diskMeta["Parámetros"].seed, 2099);
    assert.equal(diskMeta["Parámetros"].resolution, "1024x1024");
    assert.equal(diskMeta["Prompt Original"].prompt, "Retrato Cyberpunk Neón 2099!");
    assert.equal(diskMeta["Prompt Original"].negative_prompt, "baja calidad, deformado");
    assert.equal(diskMeta["Métricas"].inference_time_ms, 840);
    assert.equal(diskMeta["Métricas"].cost_usd, 0);
    assert.equal(diskMeta["Contexto"].session_id, "sess_test_01");
    assert.equal(diskMeta["Contexto"].output_file, saved.fileName);

    // 5.4 Guardado descargando desde imageUrl del servidor mock permitido
    const savedFromUrl = await freeaiBridge.saveImageToBiblioteca({
      projectPath: projectDir,
      allowedRoot: tempRoot,
      imageUrl: `http://127.0.0.1:${mockPort}/v1/assets/render_out.png`,
      prompt: "Boceto Industrial Vizcom",
      model: "controlnet-union-sdxl-promax",
      params: {
        control_type: "scribble",
        control_strength: 0.75
      }
    });
    assert.equal(savedFromUrl.ok, true);
    assert.equal(fs.existsSync(savedFromUrl.imagePath), true);
  });
});
