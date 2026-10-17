import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaybackRange } from "../public/transport.mjs";
import { parseNotation } from "../public/model.mjs";

test("起播位置独立于范围，A/B 包含尾音并允许单音循环", () => {
  const notes = parseNotation("1 23\n45"),
    p = new PlaybackRange();
  p.reset(notes);
  assert.equal(p.cursor, 0);
  p.cursor = 3;
  assert.deepEqual(p.plan(notes), {
    start: 0,
    end: notes.length,
    initialIndex: 3,
  });
  p.setMarker("a", notes, 2);
  p.setMarker("b", notes, 5);
  p.scope = "ab";
  assert.deepEqual(p.plan(notes), { start: 2, end: 6, initialIndex: 3 });
  assert.throws(() => p.setMarker("b", notes, 0));
  assert.equal(p.b, 5);
  p.a = p.b = 2;
  assert.deepEqual(p.plan(notes), { start: 2, end: 3, initialIndex: 2 });
});
test("修改时值保留端点，插入前文后跟随原音，删除端点解除区间循环", () => {
  const notes = parseNotation("1234"),
    p = new PlaybackRange();
  p.reset(notes);
  p.cursor = 1;
  p.a = 1;
  p.b = 3;
  p.scope = "ab";
  p.loop = true;
  notes[1].duration = 2;
  p.rebase(notes.slice(), notes);
  assert.equal(p.a, 1);
  assert.equal(p.b, 3);
  const inserted = [...parseNotation("56"), ...notes];
  p.rebase(notes, inserted);
  assert.equal(p.cursor, 3);
  assert.equal(p.a, 3);
  assert.equal(p.b, 5);
  const deleted = inserted.filter((_, i) => i !== 3);
  p.rebase(inserted, deleted);
  assert.equal(p.a, null);
  assert.equal(p.scope, "all");
  assert.equal(p.loop, false);
  p.reset([]);
  assert.equal(p.cursor, -1);
  assert.throws(() => p.setMarker("a", []));
});

test("编辑撤销与重做不恢复旧的播放位置或覆盖后来设置的端点", () => {
  const score = { notes: parseNotation("1234") },
    p = new PlaybackRange();
  p.reset(score.notes);
  const undo = p.copyScore(score);
  score.notes[0].duration = 2;
  p.cursor = 2;
  p.a = 1;
  p.b = 3;
  p.scope = "ab";
  p.loop = true;
  const redo = p.copyScore(score);
  p.rebase(score.notes, undo.notes);
  assert.deepEqual(
    [p.cursor, p.a, p.b, p.scope, p.loop],
    [2, 1, 3, "ab", true],
  );
  p.rebase(undo.notes, redo.notes);
  assert.deepEqual(
    [p.cursor, p.a, p.b, p.scope, p.loop],
    [2, 1, 3, "ab", true],
  );
  assert.equal(undo.notes[0].duration, 1);
  assert.equal(redo.notes[0].duration, 2);
});
