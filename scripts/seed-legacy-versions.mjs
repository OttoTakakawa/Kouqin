// 从明确指定的已有历史快照恢复保存指纹；不使用当前文件来猜旧稿基础。
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export async function seedLegacyVersions(data, snapshotRoots, relativeData = "") {
  if (relativeData.split(/[\\/]/).includes("..") || path.isAbsolute(relativeData))
    throw Error("曲库相对路径无效");
  const prefix = relativeData ? relativeData.replaceAll("\\", "/") + "/" : "";
  const entries = new Map();
  for (const root of snapshotRoots) {
    const manifest = JSON.parse((await fs.readFile(path.join(root, "manifest.json"), "utf8")).replace(/^\uFEFF/, ""));
    if (!Array.isArray(manifest)) throw Error("快照校验清单格式无效");
    for (const row of manifest) {
      const relative = row.Path?.replaceAll("\\", "/");
      if (!relative?.startsWith(prefix)) continue;
      const file = relative.slice(prefix.length);
      if (!/^[a-zA-Z0-9-]{1,80}\.json$/.test(file)) continue;
      const text = await fs.readFile(path.join(root, "data", prefix, file), "utf8");
      const revision = createHash("sha256").update(text).digest("hex");
      if (revision.toUpperCase() !== row.SHA256) throw Error("历史快照校验不符：" + file);
      const { id, updatedAt } = JSON.parse(text);
      if (id + ".json" !== file || typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) continue;
      const entry = { id, updatedAt, revision };
      entries.set(JSON.stringify(entry), entry);
    }
  }
  const journal = path.join(data, ".protection", "versions.jsonl");
  await fs.mkdir(path.dirname(journal), { recursive: true });
  if (entries.size) await fs.appendFile(journal, [...entries.keys()].map(line => line + "\n").join(""));
  return entries.size;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [data, relativeData, ...snapshots] = process.argv.slice(2);
  if (!data || relativeData === undefined || !snapshots.length)
    throw Error("用法：node scripts/seed-legacy-versions.mjs <曲库> <快照内相对曲库路径> <历史快照目录...>");
  console.log("已导入历史保存指纹：" + await seedLegacyVersions(data, snapshots, relativeData));
}
