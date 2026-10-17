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
  durationName,
  NOTE_DURATIONS,
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
test("倍低音与倍高音保留括号作用域、音高与导出再导入", () => {
  const notes = parseNotation("(1(7)#2) [[#1]2] 0");
  const voiced = notes.filter((n) => n.type === "note");
  assert.deepEqual(voiced.map((n) => [n.degree, n.octave, n.sharp]), [
    [1, -1, false], [7, -2, false], [2, -1, true],
    [1, 2, true], [2, 1, false], [0, 0, false],
  ]);
  const s = validateScore({ ...score(), notes });
  assert.deepEqual(parseNotation(serializeNotation(notes)), notes);
  assert.deepEqual(timeline(s).events.map((e) => e.note), [48, 47, 51, 85, 74, null]);
  for (const text of ["[(1)]", "([1])", "(((1)))", "[[[1]]]", "((1)", "[1))", "(1#)"])
    assert.throws(() => parseNotation(text));
  for (const octave of [-3, 3, 0.5, null, "-2"])
    assert.throws(() => validateScore({ ...s, notes: [{ ...voiced[0], octave }] }));
});
test("尾音延长与段后留白分别进入时间轴，基本音长保持不变", () => {
  const s = {
    ...score(),
    bpm: 120,
    durationScale: 0.5,
    notes: [
      {
        type: "note",
        degree: 1,
        octave: 0,
        sharp: false,
        duration: 1,
        tailHold: 2,
      },
      { type: "note", degree: 0, octave: 0, sharp: false, duration: 2 },
      { type: "note", degree: 3, octave: 0, sharp: false, duration: 1 },
    ],
  };
  validateScore(s);
  const t = timeline(s);
  assert.deepEqual(
    t.events.map((e) => [e.note, e.at, e.duration]),
    [
      [60, 0, 0.75],
      [null, 0.75, 0.5],
      [64, 1.25, 0.25],
    ],
  );
  assert.equal(t.duration, 1.5);
  assert.equal(s.notes[0].duration, 1);
  for (const tailHold of [-1, 5, null, NaN])
    assert.throws(() =>
      validateScore({ ...s, notes: [{ ...s.notes[0], tailHold }] }),
    );
  assert.throws(() =>
    validateScore({ ...s, notes: [{ ...s.notes[1], tailHold: 1 }] }),
  );
});
test("整体音长同比缩放音符与休止，兼容旧谱并拒绝无效倍率", () => {
  const s = score();
  const originalNotes = structuredClone(s.notes);
  const base = timeline(s);
  const half = timeline(validateScore({ ...s, durationScale: 0.5 }));
  assert.equal(half.duration, base.duration / 2);
  assert.deepEqual(
    half.events,
    base.events.map((e) => ({ ...e, at: e.at / 2, duration: e.duration / 2 })),
  );
  const phrase = phraseRange(s.notes, 0);
  assert.equal(
    timeline({ ...s, durationScale: 2 }, phrase.start, phrase.end).duration,
    timeline(s, phrase.start, phrase.end).duration * 2,
  );
  assert.deepEqual(s.notes, originalNotes);
  for (const durationScale of [0, 0.24, 2.01, null, "0.5", NaN, Infinity])
    assert.throws(() => validateScore({ ...s, durationScale }));
});
test("默认按标准音长步进，可加入附点，旧的估计值按方向归入标准档", () => {
  assert.equal(durationChange(1, 1), 2);
  assert.equal(durationChange(2, -1), 1);
  assert.equal(durationChange(0.5, -1), 0.25);
  assert.equal(durationChange(0.25, -1), 0.125);
  assert.equal(durationChange(1, 1, true), 1.5);
  assert.equal(durationChange(2, -1, true), 1.5);
  assert.equal(durationChange(0.25, -1, true), 0.1875);
  assert.equal(durationChange(2.5, 1), 4);
  assert.equal(durationChange(2.5, -1), 2);
  assert.equal(durationName(1), "四分音符");
  assert.equal(durationName(0.75), "附点八分音符");
  assert.equal(durationName(2.5), "自定音长");
  for (const step of NOTE_DURATIONS)
    assert.equal(
      validateScore({
        ...score(),
        notes: [{ ...score().notes[0], duration: step.value }],
      }).notes[0].duration,
      step.value,
    );
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
  const edited = { ...score(), title: "修改后的曲子", durationScale: 0.5 };
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
  const extended = { ...edited, notes: parseNotation("((#1)) (7) [[2]]") };
  assert.equal((await post(extended)).status, 200);
  const extendedReadback = (await (await get("/api/scores")).json())[0];
  assert.deepEqual(extendedReadback.notes, extended.notes);
  assert.equal(serializeNotation(extendedReadback.notes), "((#1)) (7) [[2]]");
  assert.equal(
    (await post({ ...extended, notes: [{ ...extended.notes[0], octave: -3 }] })).status,
    400,
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
