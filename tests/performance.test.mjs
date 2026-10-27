import test from "node:test";
import assert from "node:assert/strict";
import { buildPerformance, noteEnvelope } from "../public/performance.mjs";
import { validateScore, timeline } from "../public/model.mjs";

const note = (degree, duration = 1, octave = 0, performance) => ({
  type: "note",
  degree,
  duration,
  octave,
  sharp: false,
  ...(performance ? { performance } : {}),
});
const score = (notes, extra = {}) => ({
  version: 1,
  id: "stage-test",
  title: "演出",
  key: "C",
  bpm: 120,
  notes,
  ...extra,
});

test("自动演出区分稀疏低音与密集高音，不把所有重复乐句识别为副歌", () => {
  const value = score([
    note(1, 2, -1),
    note(3, 2, -1),
    { type: "break" },
    ...Array.from({ length: 12 }, (_, i) => note(i % 2 ? 7 : 3, 0.25, 1)),
  ]);
  const data = buildPerformance(value);
  assert.ok(data.byIndex.get(3).energy > data.byIndex.get(0).energy + 0.35);
  assert.equal(data.byIndex.get(3).mode, "surge");
  const repeated = buildPerformance(
    score([
      ...Array.from({ length: 4 }, () => note(1, 2)),
      { type: "break" },
      ...Array.from({ length: 4 }, () => note(1, 2)),
    ]),
  );
  assert.ok(
    [...repeated.byIndex.values()].every(
      (event) => event.mode !== "chorus" && event.energy < 0.5,
    ),
  );
});

test("明确副歌覆盖稀疏旋律，休止保持安静，平缓标记覆盖快速高音", () => {
  const data = buildPerformance(
    score([
      note(1, 4, -1, "chorus"),
      note(0, 2, 0, "chorus"),
      { type: "break" },
      note(7, 0.125, 2, "calm"),
    ]),
  );
  assert.equal(data.byIndex.get(0).energy, 1);
  assert.equal(data.byIndex.get(0).mode, "chorus");
  assert.equal(data.byIndex.get(1).mode, "rest");
  assert.equal(noteEnvelope(data.byIndex.get(1), 2.2).sustain, 0);
  assert.equal(data.byIndex.get(3).energy, 0.16);
});

test("演出共用真实时间轴，包括尾音、旧倍率、无时值分隔与全曲音符索引", () => {
  const first = { ...note(3, 1, 0, "chorus"), tailHold: 2 };
  const value = score(
    [first, { type: "space" }, { type: "break" }, note(5, 0.5)],
    { durationScale: 1.5 },
  );
  const data = buildPerformance(value);
  assert.deepEqual(data.events, timeline(value).events);
  assert.equal(data.byIndex.get(0).duration, 2.25);
  assert.equal(data.byIndex.get(3).at, 2.25);
  assert.equal(data.beatSeconds, 0.75);
  assert.equal(data.byIndex.get(0).last, true);
});

test("音头只在起音出现，长音持续；定位到音符中间不重放爆点", () => {
  const event = buildPerformance(score([note(5, 4)])).byIndex.get(0);
  assert.equal(noteEnvelope(event, 0).attack, 1);
  assert.ok(noteEnvelope(event, 1).attack < 0.001);
  assert.equal(noteEnvelope(event, 1).sustain, 1);
  assert.equal(noteEnvelope(event, 1).progress, 0.5);
  assert.deepEqual(noteEnvelope(event, 2), {
    attack: 0,
    sustain: 0,
    progress: 0,
  });
});

test("副歌标记随 JSON 导出重读保留，不更改音长音高，拒绝非法标记", () => {
  const value = score([note(6, 1.5, 1, "chorus"), note(1, 2, 0, "calm")]);
  const restored = validateScore(JSON.parse(JSON.stringify(value)));
  assert.deepEqual(restored, value);
  const plain = structuredClone(value);
  plain.notes.forEach((entry) => delete entry.performance);
  assert.deepEqual(timeline(restored), timeline(plain));
  value.notes[0].performance = "explosive";
  assert.throws(() => validateScore(value), /段落演出/);
});
