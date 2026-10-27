import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { validateScore } from "./public/model.mjs";
const base = path.dirname(fileURLToPath(import.meta.url));
const library =
  process.env.HARMONICA_LIBRARY ||
  "F:\\大图书馆WIn\\BaiduSyncdisk\\软件笔记\\D_口琴与乐理\\01_乐谱";
const vault = process.env.HARMONICA_VAULT || path.resolve(library, "../..");
const data = process.env.HARMONICA_DATA || path.join(base, "data");
await fs.mkdir(data, { recursive: true });
async function walk(dir, ext) {
  let result = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) result.push(...(await walk(p, ext)));
    else if (ext.test(e.name)) result.push(p);
  }
  return result;
}
let originals = [];
let libraryError = "";
try {
  originals = (await walk(library, /\.md$/i)).map((p, i) => ({
    id: String(i),
    title: path.basename(p, ".md"),
    category: path.relative(library, path.dirname(p)),
    path: p,
  }));
} catch (e) {
  libraryError = "乐谱目录无法读取，请检查 HARMONICA_LIBRARY 设置。";
}
let imageMap;
async function images() {
  if (!imageMap) {
    imageMap = walk(vault, /\.(png|jpe?g|webp|gif)$/i)
      .then((files) => {
        const map = new Map();
        for (const p of files) {
          const name = path.basename(p);
          if (!map.has(name)) map.set(name, []);
          map.get(name).push(p);
        }
        return map;
      })
      .catch((e) => {
        imageMap = null;
        throw e;
      });
  }
  return imageMap;
}
const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
};
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const writeQueue = new Map();
const revisionOf = (text) => createHash("sha256").update(text).digest("hex");
// 只记录已知保存版本和校验过的历史快照，不把启动时磁盘内容当成旧稿的基础。
const legacyVersions = new Map();
const versionJournal = path.join(data, ".protection", "versions.jsonl");
function rememberVersion({ id, updatedAt, revision }) {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id || "") ||
      typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt)) ||
      !/^[a-f0-9]{64}$/.test(revision || "")) return;
  const key = id + ":" + updatedAt;
  if (!legacyVersions.has(key)) legacyVersions.set(key, new Set());
  legacyVersions.get(key).add(revision);
}
async function loadLegacyVersions() {
  try {
    for (const line of (await fs.readFile(versionJournal, "utf8")).split("\n")) {
      try { rememberVersion(JSON.parse(line)); } catch {} // 未写完的记录只会失去兼容资格，不放开覆盖。
    }
  } catch (e) { if (e.code !== "ENOENT") throw e; }
}
await loadLegacyVersions();
async function recordVersions(entries) {
  await fs.mkdir(path.dirname(versionJournal), { recursive: true });
  await fs.appendFile(versionJournal, entries.map(e => JSON.stringify(e) + "\n").join(""));
  entries.forEach(rememberVersion);
}
async function serialized(id, action) {
  const previous = writeQueue.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  writeQueue.set(id, next);
  try {
    return await next;
  } finally {
    if (writeQueue.get(id) === next) writeQueue.delete(id);
  }
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = url.pathname;
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || ""))
      return json(res, 403, { error: "仅允许本机访问" });
    // file:// 书签只读探测；不返回曲库路径、谱面或会话，不放开其他API的跨域权限。
    if (route === "/api/launcher" && req.method === "GET" &&
        (!req.headers.origin || req.headers.origin === "null" || req.headers.origin === `http://${req.headers.host}`)) {
      res.setHeader("Cache-Control", "no-store");
      if (req.headers.origin === "null") {
        res.setHeader("Access-Control-Allow-Origin", "null");
        res.setHeader("Vary", "Origin");
      }
      let config = { data: "" };
      try {
        const text = await fs.readFile(path.join(base, "tools/webui-launcher/launcher.json"), "utf8");
        config = JSON.parse(text.replace(/^\uFEFF/, ""));
        if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 ||
            (config.data != null && typeof config.data !== "string")) throw Error("invalid config");
      } catch (error) {
        if (error.code !== "ENOENT") return json(res, 503, { error: "启动配置 launcher.json 无效，请修正后重试。" });
      }
      const expected = path.resolve(base, config.data || "data");
      const normalize = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
      if (normalize(expected) !== normalize(data))
        return json(res, 409, { error: "当前端口的 Harmonica 使用了另一个曲库，未进入。" });
      try {
        const resources = await Promise.all(["public/index.html", "dist/app.js"].map(file => fs.stat(path.join(base, file))));
        if (resources.some(file => !file.isFile() || file.size === 0)) throw Error("empty resource");
      } catch {
        return json(res, 503, { error: "写谱台页面资源尚未就绪，请重试启动。" });
      }
      return json(res, 200, { ok: true, app: "harmonica-studio", version: 1 });
    }
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`
    )
      return json(res, 403, { error: "不允许跨站访问" });
    if (route === "/api/health")
      return json(res, 200, {
        ok: true,
        app: "harmonica-studio",
        dataDirectory: path.resolve(data),
        version: 1,
        legacyAutoSave: true,
        libraryCount: originals.length,
        libraryError,
      });
    if (route === "/api/library")
      return json(res, 200, {
        items: originals.map(({ path, ...x }) => x),
        error: libraryError,
      });
    if (route === "/api/original") {
      const item = originals.find((x) => x.id === url.searchParams.get("id"));
      if (!item) return json(res, 404, { error: "乐谱不存在" });
      const text = await fs.readFile(item.path, "utf8");
      const refs = [...text.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(
        (m) => m[1],
      );
      return json(res, 200, {
        text,
        images: refs.map((_, i) => `/api/image?id=${item.id}&n=${i}`),
      });
    }
    if (route === "/api/image") {
      const item = originals.find((x) => x.id === url.searchParams.get("id"));
      if (!item) return json(res, 404, { error: "不存在" });
      const text = await fs.readFile(item.path, "utf8");
      const refs = [...text.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map(
        (m) => m[1],
      );
      const ref = refs[Number(url.searchParams.get("n"))];
      if (!ref) return json(res, 404, { error: "图片不存在" });
      const matches = (await images()).get(path.basename(ref)) || [];
      if (matches.length !== 1)
        return json(res, 404, { error: "图片缺失或重名，无法唯一定位" });
      res.writeHead(200, {
        "Content-Type":
          mime[path.extname(matches[0]).toLowerCase()] ||
          "application/octet-stream",
      });
      return res.end(await fs.readFile(matches[0]));
    }
    if (route === "/api/scores" && req.method === "GET") {
      const files = (await fs.readdir(data)).filter((p) => p.endsWith(".json"));
      return json(
        res,
        200,
        await Promise.all(
          files.map(async (p) => {
            const text = await fs.readFile(path.join(data, p), "utf8");
            return { ...JSON.parse(text), revision: revisionOf(text) };
          }),
        ),
      );
    }
    if (route.startsWith("/api/scores/") && req.method === "DELETE") {
      const id = route.slice("/api/scores/".length);
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(id))
        return json(res, 400, { error: "无效的乐谱 ID" });
      await serialized(id, async () => {
        const trash = path.join(data, "trash");
        await fs.mkdir(trash, { recursive: true });
        await fs.rename(
          path.join(data, id + ".json"),
          path.join(trash, id + "-" + Date.now() + ".json"),
        );
      });
      return json(res, 200, { ok: true });
    }
    if (route === "/api/scores" && req.method === "POST") {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 2e6) return json(res, 413, { error: "文件过大" });
        chunks.push(chunk);
      }
      const score = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let expectedRevision = score.revision;
      delete score.revision;
      validateScore(score);
      const result = await serialized(score.id, async () => {
        const target = path.join(data, score.id + ".json");
        const temp = target + "." + crypto.randomUUID() + ".tmp";
        let current;
        try {
          current = await fs.readFile(target, "utf8");
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        if (current === undefined && !expectedRevision && score.updatedAt)
          return { status: 409, error: "原曲库已没有这首乐谱，已拒绝用旧草稿重建；当前编辑仍保留，可另存副本。" };
        if (current !== undefined && !expectedRevision) {
          const known = legacyVersions.get(score.id + ":" + score.updatedAt);
          if (!known || known.size !== 1)
            return { status: 428, error: "这份旧草稿的基础版本无法自动确认，需核对后保存；当前编辑仍保留。" };
          expectedRevision = [...known][0];
        }
        if ((current !== undefined && expectedRevision !== revisionOf(current)) ||
            (current === undefined && expectedRevision))
          return { status: 409, error: "乐谱已被其他页面或外部修改（也可能已删除），已拒绝覆盖。当前编辑仍保留，请先导出 JSON，再刷新曲库核对。" };
        score.updatedAt = new Date().toISOString();
        const text = JSON.stringify(score, null, 2);
        const versions = [{ id: score.id, updatedAt: score.updatedAt, revision: revisionOf(text) }];
        if (current !== undefined) {
          const previous = JSON.parse(current);
          versions.push({ id: score.id, updatedAt: previous.updatedAt, revision: revisionOf(current) });
        }
        // 在替换前记下内容指纹；写失败时不会使不匹配的旧稿获得覆盖资格。
        await recordVersions(versions);
        try {
          await fs.copyFile(target, target + ".bak");
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        try {
          await fs.writeFile(temp, text);
          await fs.rename(temp, target);
        } finally {
          await fs.rm(temp, { force: true });
        }
        return { status: 200, ok: true, updatedAt: score.updatedAt, revision: revisionOf(text) };
      });
      const { status, ...body } = result;
      return json(res, status, body);
    }
    if (req.method !== "GET") return json(res, 405, { error: "不支持的操作" });
    const allowed = new Set([
      "index.html",
      "model.mjs",
      "performance.mjs",
      "practice-overview.mjs",
      "style.css",
      "favicon.svg",
      "audio/harmonica-mp3.js",
      "audio/musyngkite-harmonica-mp3.js",
      "audio/generaluser-harmonica-mp3.js",
      "audio/vcsl-normal-harmonica-mp3.js",
      "audio/vcsl-soft-harmonica-mp3.js",
      "audio/vcsl-vib-harmonica-mp3.js",
      "audio/harmonica-loop.json",
      "app.js",
    ]);
    const name = route === "/" ? "index.html" : route.slice(1);
    if (!allowed.has(name)) return json(res, 404, { error: "不存在" });
    const target =
      name === "app.js"
        ? path.join(base, "dist", "app.js")
        : path.join(base, "public", name);
    const body = await fs.readFile(target);
    res.writeHead(200, {
      "Content-Type": mime[path.extname(name)],
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": name.startsWith("audio/")
        ? "public, max-age=86400"
        : "no-cache",
    });
    res.end(body);
  } catch (e) {
    json(res, e.code === "ENOENT" ? 404 : 400, {
      error: e.code === "ENOENT" ? "文件不存在" : e.message,
    });
  }
});
server.listen(
  process.env.PORT === undefined ? 4317 : Number(process.env.PORT),
  "127.0.0.1",
  () =>
    console.log("Harmonica Studio: http://127.0.0.1:" + server.address().port),
);
