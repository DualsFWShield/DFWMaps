import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURI(urlObj.pathname);

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
        if (id.includes("siwis")) { label = "Siwis (Féminine · Standard)"; gender = "female"; }
        else if (id.includes("tom")) { label = "Tom (Masculine · Naturelle)"; gender = "male"; }
        else if (id.includes("mls_1840")) { label = "MLS 1840 (Masculine · Légère)"; gender = "male"; }
        else if (id.includes("mls")) { label = "MLS Studio (Féminine · HD)"; gender = "female"; }
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
  console.log(`Server running at http://localhost:${PORT}`);
});
