import test from "node:test";
import assert from "node:assert/strict";
import { timeline, validateScore, phraseRepeat } from "../public/model.mjs";
import { buildPerformance } from "../public/performance.mjs";
const note = (degree, extra = {}) => ({type:"note", degree, octave:0, sharp:false, duration:1, ...extra});
const score = notes => ({version:1, id:"repeat-test", title:"行重复", key:"C", bpm:120, notes});

test("行重复展开顺序、休止尾音、时长及后续行，原音符不复制", () => {
  const s = score([note(1,{repeat:3,tailHold:1}), note(0,{repeat:3}), {type:"break"}, note(5)]);
  const original = structuredClone(s);
  const seq = timeline(validateScore(s));
  assert.deepEqual(seq.events.map(e => e.index), [0,1,0,1,0,1,3]);
  assert.deepEqual(seq.events.map(e => e.at), [0,1,1.5,2.5,3,4,4.5]);
  assert.equal(seq.duration,5);
  assert.equal(timeline({...s,durationScale:2}).duration,10);
  assert.deepEqual(s,original);
  assert.equal(timeline(s,0,2).duration,4.5);
  assert.deepEqual(timeline(s,1,4).events.map(e=>e.index),[1,3]);
  assert.equal(timeline(s,0,1).duration,1);
  const spaced = score([{type:"space"},note(1,{repeat:2}),note(2,{repeat:2}),{type:"space"}]);
  assert.deepEqual(timeline(spaced,1,3).events.map(e=>e.index),[1,2,1,2]);
});

test("空行、末行、删除首音、拆行和合行的重复计数稳定", () => {
  assert.equal(timeline(score([{type:"break"},note(3,{repeat:2}),{type:"break"}])).duration,1);
  assert.equal(timeline(score([note(3,{repeat:8})])).events.length,8);
  assert.equal(phraseRepeat([note(2,{repeat:2}),note(3,{repeat:4})],0,2),4);
  const notes = [note(1,{repeat:2}),note(2,{repeat:2}),note(3,{repeat:2})];
  notes.shift();
  assert.equal(timeline(score(notes)).events.length,4);
  notes.splice(1,0,{type:"break"});
  assert.equal(timeline(score(notes)).events.length,4);
  for(const repeat of [0,1,9,2.5,"2",null])
    assert.throws(()=>validateScore(score([note(1,{repeat})])));
  assert.throws(()=>validateScore(score([{type:"break",repeat:2}])));
});

test("重复行后的演出仍映射正确音符与手动标注", () => {
  const s = score([note(1,{repeat:3}), note(2,{repeat:3}), {type:"break"},note(6,{performance:"chorus"})]);
  const data = buildPerformance(s);
  assert.equal(data.duration,3.5);
  assert.equal(data.byIndex.get(3).note,69);
  assert.equal(data.byIndex.get(3).at,3);
  assert.equal(data.byIndex.get(3).mode,"chorus");
});
