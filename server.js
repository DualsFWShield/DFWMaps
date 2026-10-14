import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const PIPER_SERVER_URL = process.env.PIPER_SERVER_URL || "http://127.0.0.1:5000";

// Cache mémoire des synthèses Piper pour un débit instantané en guidage GPS
const ttsCache = new Map();
const MAX_CACHE_ENTRIES = 120;

function findPiperExecutable() {
  if (process.env.PIPER_BIN && fs.existsSync(process.env.PIPER_BIN)) {
    return process.env.PIPER_BIN;
  }
  const isWin = process.platform === "win32";
  const binaryName = isWin ? "piper.exe" : "piper";
  const localCandidates = [
    path.join(__dirname, "piper", binaryName),
    path.join(__dirname, "piper-voice", binaryName),
    path.join(__dirname, binaryName),
  ];
  for (const c of localCandidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const testCmd = isWin ? `where ${binaryName}` : `which ${binaryName}`;
    const out = execSync(testCmd, { stdio: ["pipe", "pipe", "ignore"], encoding: "utf8" }).trim();
    if (out) return out.split(/\r?\n/)[0].trim();
  } catch {}
  return null;
}

const detectedPiperBin = findPiperExecutable();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".onnx": "application/octet-stream",
  ".wav": "audio/wav",
};

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURI(urlObj.pathname);

  // État du moteur TTS Piper
  if (pathname === "/api/tts/status") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      piperAvailable: Boolean(detectedPiperBin),
      piperPath: detectedPiperBin,
      piperServerUrl: PIPER_SERVER_URL,
      engine: detectedPiperBin ? "piper-native" : "web-speech-hd",
      cacheSize: ttsCache.size,
    }));
    return;
  }

  // Synthèse vocale neuronale Piper
  if (pathname === "/api/tts") {
    const text = (urlObj.searchParams.get("text") || "").trim();
    const voiceId = urlObj.searchParams.get("voice") || "fr_FR-siwis-medium";
    const lengthScale = urlObj.searchParams.get("rate") ? (1.0 / Math.max(0.6, Math.min(1.5, parseFloat(urlObj.searchParams.get("rate"))))).toFixed(2) : "1.0";

    if (!text) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "missing_text" }));
      return;
    }

    const cacheKey = `${voiceId}::${lengthScale}::${text}`;
    if (ttsCache.has(cacheKey)) {
      const cached = ttsCache.get(cacheKey);
      res.statusCode = 200;
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("X-Piper-Cache", "HIT");
      res.setHeader("Content-Length", cached.length);
      res.end(cached);
      return;
    }

    const voicesDir = path.join(__dirname, "piper-voice", "fr-FR");
    const onnxModel = path.join(voicesDir, `${voiceId}.onnx`);

    if (detectedPiperBin && fs.existsSync(onnxModel)) {
      const tmpWav = path.join(os.tmpdir(), `dfw-piper-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
      const piperArgs = [
        "--model", onnxModel,
        "--output_file", tmpWav,
        "--length_scale", lengthScale,
      ];
      const modelJson = `${onnxModel}.json`;
      if (fs.existsSync(modelJson)) {
        piperArgs.push("--config", modelJson);
      }

      try {
        const proc = spawn(detectedPiperBin, piperArgs, { stdio: ["pipe", "pipe", "pipe"] });
        proc.stdin.write(text);
        proc.stdin.end();

        proc.on("close", (code) => {
          if (code === 0 && fs.existsSync(tmpWav)) {
            try {
              const wavBuf = fs.readFileSync(tmpWav);
              fs.unlink(tmpWav, () => {});
              if (ttsCache.size >= MAX_CACHE_ENTRIES) {
                const firstKey = ttsCache.keys().next().value;
                ttsCache.delete(firstKey);
              }
              ttsCache.set(cacheKey, wavBuf);

              res.statusCode = 200;
              res.setHeader("Content-Type", "audio/wav");
              res.setHeader("X-Piper-Cache", "MISS");
              res.setHeader("Content-Length", wavBuf.length);
              res.end(wavBuf);
              return;
            } catch (readErr) {
              console.warn("Erreur lecture WAV Piper:", readErr);
            }
          }
          try { if (fs.existsSync(tmpWav)) fs.unlinkSync(tmpWav); } catch {}
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "piper_execution_failed" }));
        });

        proc.on("error", (err) => {
          res.statusCode = 502;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "piper_spawn_error", details: String(err) }));
        });
        return;
      } catch (spawnErr) {
        res.statusCode = 502;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "piper_failed", details: String(spawnErr) }));
        return;
      }
    }

    // Piper non disponible côté serveur : informer le client pour bascule Web Speech HD immédiate
    res.statusCode = 501;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      available: false,
      error: "piper_native_unavailable",
      message: "Exécutable Piper non détecté localement. Bascule vers la synthèse vocale neuronale Web Speech HD.",
    }));
    return;
  }

  // Endpoint API des voix Piper installées localement
  if (pathname === "/api/piper-voices") {
    const voicesDir = path.join(__dirname, "piper-voice", "fr-FR");
    fs.readdir(voicesDir, (err, files) => {
      if (err) {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ voices: [] }));
        return;
      }

      const onnxFiles = files.filter((f) => f.endsWith(".onnx"));
      const voices = onnxFiles.map((f) => {
        const id = f.replace(".onnx", "");
        const hasJson = files.includes(`${f}.json`);
        const stats = fs.statSync(path.join(voicesDir, f));
        let label = id;
        let gender = "unknown";
        if (id.includes("siwis")) { label = "Siwis (Féminine · Claire & Naturelle)"; gender = "female"; }
        else if (id.includes("tom")) { label = "Tom (Masculine · Naturelle & Posée)"; gender = "male"; }
        else if (id.includes("mls_1840")) { label = "MLS 1840 (Masculine · Douce)"; gender = "male"; }
        else if (id.includes("mls")) { label = "MLS Studio (Féminine · Studio HD)"; gender = "female"; }
        else if (id.includes("gilles")) { label = "Gilles (Masculine · Dynamique)"; gender = "male"; }
        else if (id.includes("upmc")) { label = "UPMC (Féminine · Expressive)"; gender = "female"; }

        return {
          id,
          label,
          gender,
          file: f,
          jsonFile: hasJson ? `${f}.json` : null,
          sizeBytes: stats.size,
          path: `/piper-voice/fr-FR/${f}`,
        };
      });

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ voices }));
    });
    return;
  }

  let reqPath = pathname;
  if (reqPath === "/" || reqPath === "") reqPath = "/index.html";

  const safePath = path.normalize(path.join(__dirname, reqPath));
  if (!safePath.startsWith(__dirname)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  fs.stat(safePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    fs.createReadStream(safePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Mon Maps démarré sur http://localhost:${PORT}`);
  if (detectedPiperBin) {
    console.log(`🎙️ [PiperTTS] Moteur neuronal Piper ONNX détecté : ${detectedPiperBin}`);
  } else {
    console.log(`🎙️ [PiperTTS] Mode Web Speech HD actif (voix neuronales naturelles du navigateur)`);
  }
});
