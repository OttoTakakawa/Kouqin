import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { seedLegacyVersions } from "../scripts/seed-legacy-versions.mjs";

const sample = { version: 1, id: "legacy-seeded", title: "历史原谱", key: "C", bpm: 90,
  updatedAt: "2026-10-17T10:00:00.000Z", notes: [{ type: "note", degree: 1, octave: 0, sharp: false, duration: 1 }] };
async function start(data) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url), env: { ...process.env, PORT: "0", HARMONICA_DATA: data, HARMONICA_LIBRARY: path.join(data, "absent") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const address = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(Error("服务启动超时")), 10000);
    child.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    child.once("error", reject);
  });
  return {
    post: value => fetch(address + "/api/scores", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }),
    stop: async () => { if (child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; } },
  };
}
test("历史快照初始化兼容指纹，重启后自动保存仍留备份；外部不改保存时间也拦截", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harmonica-legacy-"));
  const data = path.join(root, "active"), snapshot = path.join(root, "snapshot");
  await fs.mkdir(data);
  await fs.mkdir(path.join(snapshot, "data", "preview"), { recursive: true });
  const raw = JSON.stringify(sample, null, 2);
  const original = path.join(data, sample.id + ".json");
  await fs.writeFile(original, raw);
  await fs.writeFile(path.join(snapshot, "data", "preview", sample.id + ".json"), raw);
  await fs.writeFile(path.join(snapshot, "manifest.json"), JSON.stringify([
    { Path: "preview/" + sample.id + ".json", SHA256: createHash("sha256").update(raw).digest("hex").toUpperCase() },
  ]));
  assert.equal(await seedLegacyVersions(data, [snapshot], "preview"), 1);
  assert.equal(await fs.readFile(original, "utf8"), raw);
  let server = await start(data);
  t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });
  let result = await server.post({ ...sample, title: "无需核对保存" });
  assert.equal(result.status, 200);
  const first = await result.json();
  assert.equal(await fs.readFile(original + ".bak", "utf8"), raw);
  await server.stop();
  server = await start(data);
  result = await server.post({ ...sample, title: "重启后继续自动保存", updatedAt: first.updatedAt });
  assert.equal(result.status, 200);
  const latest = await result.json();
  const before = await fs.readFile(original, "utf8");
  const bak = await fs.readFile(original + ".bak", "utf8");
  await server.stop();
  await fs.writeFile(original, before.replace("重启后继续自动保存", "外部修改但保存时间未变"));
  server = await start(data);
  assert.equal((await server.post({ ...sample, title: "不能覆盖外部修改", updatedAt: latest.updatedAt })).status, 409);
  assert.equal(await fs.readFile(original + ".bak", "utf8"), bak);
  assert.match(await fs.readFile(original, "utf8"), /外部修改/);
  assert.equal((await server.post({ ...sample, updatedAt: undefined })).status, 428);
  await server.stop();
  const external = await fs.readFile(original, "utf8");
  await fs.appendFile(path.join(data, ".protection", "versions.jsonl"), JSON.stringify({
    id: sample.id, updatedAt: latest.updatedAt, revision: createHash("sha256").update(external).digest("hex"),
  }) + "\npartial record\n");
  server = await start(data);
  assert.equal((await server.post({ ...sample, updatedAt: latest.updatedAt })).status, 428);
  await fs.rename(original, original + ".deleted");
  assert.equal((await server.post({ ...sample, updatedAt: latest.updatedAt })).status, 409);
  await fs.rename(original + ".deleted", original);
  const targetBefore = await fs.readFile(original, "utf8");
  await fs.writeFile(path.join(snapshot, "data", "preview", sample.id + ".json"), "快照已损坏");
  await assert.rejects(() => seedLegacyVersions(data, [snapshot], "preview"), /校验不符/);
  assert.equal(await fs.readFile(original, "utf8"), targetBefore);
});
