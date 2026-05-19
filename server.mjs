import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(process.cwd(), "dist");
const port = Number(process.env.PORT || 8080);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function resolvePath(urlPath) {
  const cleanPath = normalize(decodeURIComponent(urlPath.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const requested = join(root, cleanPath === "/" ? "index.html" : cleanPath);
  if (existsSync(requested) && statSync(requested).isFile()) return requested;
  return join(root, "index.html");
}

createServer((request, response) => {
  const filePath = resolvePath(request.url || "/");
  const extension = extname(filePath);
  response.setHeader("Content-Type", mimeTypes.get(extension) || "application/octet-stream");
  if (filePath !== join(root, "index.html")) {
    response.setHeader("Cache-Control", "public, max-age=2592000, immutable");
  }
  createReadStream(filePath)
    .on("error", () => {
      response.writeHead(500);
      response.end("Server error");
    })
    .pipe(response);
}).listen(port, "0.0.0.0", () => {
  console.log(`zuperpatch listening on ${port}`);
});
