import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  validateScore,
  frequency,
  durationChange,
  parseNotation,
  timeline,
  serializeNotation,
  phraseRange,
} from "../public/model.mjs";
const score = () => ({
  version: 1,
  id: "test-score",
  title: "测试曲",
  key: "C",
  bpm: 90,
  notes: parseNotation("(6)#1 [23]\n0"),
});
test("音高、休止、高低音与音长边界", () => {
  const s = score();
  assert.equal(validateScore(s), s);
  const notes = s.notes.filter((n) => n.type === "note");
  assert.equal(notes[0].octave, -1);
  assert.equal(notes[1].sharp, true);
  assert.equal(notes[2].octave, 1);
  assert.ok(
    Math.abs(frequency({ degree: 1, octave: 0, sharp: false }, "A") - 220) <
      0.001,
  );
  assert.equal(frequency({ degree: 0 }, "C"), 0);
  assert.equal(durationChange(0.125, -1), 0.125);
  assert.equal(durationChange(8, 1), 8);
  assert.throws(() => validateScore({ ...s, id: "../escape" }));
  assert.throws(() =>
    validateScore({ ...s, notes: [{ ...s.notes[0], duration: -1 }] }),
  );
  assert.throws(() => parseNotation("hello"));
});
test("端到端：读取原谱图片、保存重读、拒绝越界与跨站请求", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harmonica-test-"));
  const library = path.join(root, "library");
  const data = path.join(root, "data");
  await mkdir(library);
  await mkdir(path.join(root, "attachments"));
  const original = "## 乐谱\n![[score.png|800]]";
  await writeFile(path.join(library, "曲子.md"), original);
  await writeFile(
    path.join(root, "attachments", "score.png"),
    Buffer.from([137, 80, 78, 71]),
  );
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: "0",
      HARMONICA_LIBRARY: library,
      HARMONICA_VAULT: root,
      HARMONICA_DATA: data,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    child.kill();
    await once(child, "exit");
    await rm(root, { recursive: true, force: true });
  });
  const address = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(Error("启动超时")), 10000);
    child.stdout.on("data", (b) => {
      output += b;
      const m = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    child.once("error", reject);
  });
  const get = async (p) => fetch(address + p);
  assert.equal((await (await get("/api/health")).json()).libraryCount, 1);
  const list = await (await get("/api/library")).json();
  assert.equal(list.items[0].title, "曲子");
  assert.equal(list.items[0].path, undefined);
  const source = await (await get("/api/original?id=0")).json();
  assert.equal(source.text, original);
  assert.equal((await get(source.images[0])).status, 200);
  const post = async (s, headers = {}) =>
    fetch(address + "/api/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(s),
    });
  const saved = await (await post(score())).json();
  assert.ok(saved.updatedAt);
  assert.deepEqual(await (await get("/api/scores")).json(), [
    { ...score(), updatedAt: saved.updatedAt },
  ]);
  assert.equal(await readFile(path.join(library, "曲子.md"), "utf8"), original);
  const edited = { ...score(), title: "修改后的曲子" };
  const editedResult = await (await post(edited)).json();
  assert.deepEqual(
    JSON.parse(await readFile(path.join(data, "test-score.json"), "utf8")),
    { ...edited, updatedAt: editedResult.updatedAt },
  );
  assert.equal(
    JSON.parse(await readFile(path.join(data, "test-score.json.bak"), "utf8"))
      .title,
    "测试曲",
  );
  assert.equal((await post({ ...score(), id: "../escape" })).status, 400);
  assert.equal(
    (await post(score(), { Origin: "https://example.com" })).status,
    403,
  );
  assert.equal((await get("/api/original?id=999")).status, 404);
  assert.equal((await get("/server.mjs")).status, 404);
  assert.equal(
    (await fetch(address + "/api/scores/test-score", { method: "DELETE" }))
      .status,
    200,
  );
  assert.deepEqual(await (await get("/api/scores")).json(), []);
  assert.equal(await readFile(path.join(library, "曲子.md"), "utf8"), original);
});
test("分句、休止与自由时值进入播放时间轴；拒绝不完整 OCR", () => {
  const notes = parseNotation("[12] (67)\n0#3");
  assert.equal(serializeNotation(notes), "[1][2] (6)(7)\n0#3");
  notes[0].duration = 1.375;
  const seq = timeline({ ...score(), notes, bpm: 60 });
  assert.equal(seq.events.length, 6);
  assert.equal(seq.events[0].note, 72);
  assert.equal(seq.events[1].at, 1.375);
  assert.equal(seq.events[4].note, null);
  assert.equal(seq.duration, 6.375);
  assert.deepEqual(phraseRange(notes, notes.length), { start: 6, end: 8 });
  for (const value of ["(1", "[1)", "##2", "#", "(1[2])"])
    assert.throws(() => parseNotation(value));
});
