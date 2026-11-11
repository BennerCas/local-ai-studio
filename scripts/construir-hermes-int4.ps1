# ============================================================
#  Construir Hermes-3-8B-UNLOCKED-INT4 (ONNX INT4 AWQ, DirectML)
#  Local AI Studio - HUMAN AI SYNERGY BY BENNER CASTILLO
#
#  Que hace:
#    1. Comprueba Python y las dependencias de construccion.
#    2. Descarga la fuente sin censura (mlabonne lorablated, bf16).
#    3. La convierte a ONNX INT4 AWQ bloque 128 para DirectML con el
#       model builder oficial de ONNX Runtime GenAI (la misma receta
#       que Phi-3.5 "gpu-int4-awq-block-128" que ya te funciona).
#    4. Verifica el resultado (genai_config.json + .onnx) y mide su peso.
#    5. Prueba de humo opcional: arranca el backend y le pide una frase.
#
#  Uso (desde la carpeta del repo):
#    powershell -ExecutionPolicy Bypass -File .\scripts\construir-hermes-int4.ps1
#
#  Todo queda registrado en datos\pruebas\construccion-int4.log
# ============================================================

param(
    [string]$ModelosDir = "C:\antigravityAS\Modelos -ai-brains",
    [string]$Fuente = "mlabonne/Hermes-3-Llama-3.1-8B-lorablated",
    [switch]$SinPrueba,
    [switch]$UsarToken
)

$ErrorActionPreference = "Stop"
$Salida = Join-Path $ModelosDir "Hermes-3-8B-UNLOCKED-INT4"
$CacheDir = Join-Path $ModelosDir "_builder-cache"
$RepoDir = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $RepoDir "datos\pruebas"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir "construccion-int4.log"
Start-Transcript -Path $LogFile -Append | Out-Null

function Titulo($t) { Write-Host ""; Write-Host "=== $t ===" -ForegroundColor Cyan }

try {
    Titulo "1/5 Entorno"
    Write-Host "Carpeta de modelos : $ModelosDir"
    Write-Host "Fuente (sin censura): $Fuente"
    Write-Host "Salida INT4        : $Salida"
    $py = (Get-Command python -ErrorAction Stop).Source
    Write-Host "Python             : $py"
    python --version

    if (-not (Test-Path $ModelosDir)) {
        throw "No existe la carpeta de modelos: $ModelosDir (revisa -ModelosDir)"
    }

    Titulo "2/5 Dependencias de construccion"
    # El builder necesita onnxruntime-genai (ya lo usa tu backend), torch,
    # transformers, accelerate y sentencepiece. Solo instala lo que falte.
    $faltan = @()
    foreach ($mod in @("onnxruntime_genai", "torch", "transformers", "accelerate", "sentencepiece")) {
        python -c "import $mod" 2>$null
        if ($LASTEXITCODE -ne 0) { $faltan += $mod }
    }
    if ($faltan.Count -gt 0) {
        Write-Host "Faltan: $($faltan -join ', '). Instalando (puede tardar)..." -ForegroundColor Yellow
        if ($faltan -contains "torch") {
            python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
        }
        $pipNames = @()
        foreach ($m in $faltan) {
            switch ($m) {
                "onnxruntime_genai" { $pipNames += "onnxruntime-genai" }
                "torch" { }
                default { $pipNames += $m }
            }
        }
        if ($pipNames.Count -gt 0) { python -m pip install @pipNames }
        python -m pip install -U "onnxruntime-genai"
    } else {
        Write-Host "Todas presentes."
    }
    python -c "import onnxruntime_genai as og; print('onnxruntime-genai', getattr(og, '__version__', 'ok'))"

    Titulo "3/5 Descarga + conversion a ONNX INT4 AWQ (DirectML)"
    if ((Test-Path (Join-Path $Salida "genai_config.json")) -and (Get-ChildItem $Salida -Filter *.onnx -ErrorAction SilentlyContinue)) {
        Write-Host "Ya existe una construccion previa en $Salida." -ForegroundColor Yellow
        Write-Host "Borra esa carpeta si quieres reconstruir desde cero. Saltando conversion."
    } else {
        New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
        Write-Host "Esto descarga ~16 GB (bf16) y convierte. Paciencia, es lo lento."
        if (-not $UsarToken) {
            # La fuente es publica. Si hay un HF_TOKEN caducado en el entorno,
            # Hugging Face responde 401 "Repository Not Found" incluso para
            # repos publicos (visto en vivo: token "antigravity" expired).
            # Construimos en anonimo salvo -UsarToken.
            foreach ($v in @("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HUGGINGFACE_TOKEN")) {
                if (Test-Path "Env:$v") {
                    Remove-Item "Env:$v"
                    Write-Host "Token $v retirado de esta sesion (descarga publica en anonimo)." -ForegroundColor Yellow
                }
            }
        }
        $argsBuilder = @(
            "-m", "onnxruntime_genai.models.builder",
            "-m", $Fuente,
            "-o", $Salida,
            "-p", "int4",
            "-e", "dml",
            "-c", $CacheDir,
            "--extra_options", "int4_block_size=128", "int4_accuracy_level=4"
        )
        & python @argsBuilder
        if ($LASTEXITCODE -ne 0) { throw "El builder termino con error (codigo $LASTEXITCODE). Mira el log: $LogFile" }
    }

    Titulo "4/5 Verificacion"
    $cfg = Join-Path $Salida "genai_config.json"
    $onnx = Get-ChildItem $Salida -Filter *.onnx -ErrorAction SilentlyContinue
    if (-not (Test-Path $cfg)) { throw "Falta genai_config.json en ${Salida}: construccion incompleta." }
    if (-not $onnx) { throw "No hay ningun .onnx en ${Salida}: construccion incompleta." }
    $bytes = (Get-ChildItem $Salida -Recurse | Measure-Object -Property Length -Sum).Sum
    $gb = [math]::Round($bytes / 1GB, 2)
    Write-Host "genai_config.json : OK"
    Write-Host "Archivos .onnx    : $($onnx.Count)"
    Write-Host "Peso total        : $gb GB (objetivo: ~4,5 GB)"
    Write-Host ""
    Write-Host "Modelo registrado en el backend como: Hermes-3-8B-UNLOCKED-INT4" -ForegroundColor Green
    Write-Host "Aparecera en el catalogo DirectML del Studio tras reiniciar el backend."

    if (-not $SinPrueba) {
        Titulo "5/5 Prueba de humo contra el backend"
        Write-Host "Arrancando el backend del repo y pidiendole una frase al INT4..."
        Write-Host "(Si el backend ya estaba en marcha, primero lo paro para que tome el modelo nuevo.)"
        Get-CimInstance Win32_Process -Filter "Name LIKE 'python%'" | Where-Object { $_.CommandLine -match 'api_openai\.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 2

        $backend = Join-Path $RepoDir "sidecars\directml\api_openai.py"
        $env:PYTHONIOENCODING = "utf-8"
        $env:PYTHONUTF8 = "1"
        $env:PYTHONUNBUFFERED = "1"
        $proc = Start-Process -FilePath "python" -ArgumentList "`"$backend`"" -PassThru -WindowStyle Hidden

        $listo = $false
        foreach ($i in 1..90) {
            try {
                $r = Invoke-RestMethod -Uri "http://127.0.0.1:8002/v1/models" -TimeoutSec 3
                $listo = $true; break
            } catch { Start-Sleep -Seconds 2 }
        }
        if (-not $listo) { throw "El backend no levanto en 180 s. Revisa el inicio manual: python `"$backend`"" }

        $loadBody = @{ model = "Hermes-3-8B-UNLOCKED-INT4" } | ConvertTo-Json
        $load = Invoke-RestMethod -Uri "http://127.0.0.1:8002/v1/models/load" -Method Post -ContentType "application/json" -Body $loadBody -TimeoutSec 600
        Write-Host "Carga: $($load.status) - $($load.active_model)"

        $chatBody = @{
            model = "Hermes-3-8B-UNLOCKED-INT4"
            messages = @(@{ role = "user"; content = "Responde en una sola frase: que modelo eres y cuanto pesas en disco?" })
            stream = $false
            max_tokens = 80
            temperature = 0.3
        } | ConvertTo-Json -Depth 5
        $t0 = Get-Date
        $chat = Invoke-RestMethod -Uri "http://127.0.0.1:8002/v1/chat/completions" -Method Post -ContentType "application/json" -Body $chatBody -TimeoutSec 600
        $segs = [math]::Round(((Get-Date) - $t0).TotalSeconds, 1)
        $texto = $chat.choices[0].message.content
        Write-Host ""
        Write-Host "Respuesta del INT4 ($segs s):" -ForegroundColor Green
        Write-Host $texto
        Write-Host ""
        Write-Host "El backend queda en marcha (PID $($proc.Id)) con el INT4 activo." -ForegroundColor Green
        Write-Host "Siguiente paso: en el Studio, git pull y npm run probar:rapido"
    }

    Write-Host ""
    Write-Host "FIN OK. Log en $LogFile" -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Sube el log al chat de Arena para repararlo: $LogFile" -ForegroundColor Yellow
}
finally {
    Stop-Transcript | Out-Null
}
