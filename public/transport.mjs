import { phraseRange } from "./model.mjs";

// Practice navigation is independent of the editor's caret and selected range.
export class PlaybackRange {
  #ids = new WeakMap();
  #nextId = 0;
  cursor = 0;
  a = null;
  b = null;
  scope = "all";
  loop = false;

  #identity(note) {
    if (!note) return null;
    if (!this.#ids.has(note)) this.#ids.set(note, ++this.#nextId);
    return this.#ids.get(note);
  }

  copyScore(score) {
    const copy = structuredClone(score);
    score.notes.forEach((note, i) =>
      this.#ids.set(copy.notes[i], this.#identity(note)),
    );
    return copy;
  }

  reset(notes) {
    this.cursor = this.noteAt(notes, 0);
    this.a = this.b = null;
    this.scope = "all";
    this.loop = false;
  }

  noteAt(notes, index) {
    for (let i = Math.max(0, index); i < notes.length; i++)
      if (notes[i].type === "note") return i;
    for (let i = Math.min(index - 1, notes.length - 1); i >= 0; i--)
      if (notes[i].type === "note") return i;
    return -1;
  }

  get complete() {
    return this.a !== null && this.b !== null;
  }

  setMarker(name, notes, index = this.cursor) {
    if (notes[index]?.type !== "note") throw Error("先点击一个音符。");
    const a = name === "a" ? index : this.a;
    const b = name === "b" ? index : this.b;
    if (a !== null && b !== null && a > b)
      throw Error("A 起点需要在 B 终点之前；可先清除原端点。");
    this.a = a;
    this.b = b;
  }

  region(notes, scope = this.scope) {
    if (scope === "ab") {
      if (!this.complete) throw Error("先设置 A 起点和 B 终点。");
      return { start: this.a, end: this.b + 1 };
    }
    if (scope === "phrase") return phraseRange(notes, Math.max(0, this.cursor));
    return { start: 0, end: notes.length };
  }

  plan(notes, scope = this.scope) {
    const region = this.region(notes, scope);
    return {
      ...region,
      initialIndex:
        this.cursor >= region.start && this.cursor < region.end
          ? this.cursor
          : region.start,
    };
  }

  rebase(before, after) {
    const positions = new Map(
      after.map((note, i) => [this.#identity(note), i]),
    );
    const relocate = (index) => {
      if (index === null) return null;
      return positions.get(this.#identity(before[index])) ?? null;
    };
    const movedCursor = relocate(this.cursor);
    this.cursor = movedCursor ?? this.noteAt(after, this.cursor);
    this.a = relocate(this.a);
    this.b = relocate(this.b);
    if (this.scope === "ab" && !this.complete) {
      this.scope = "all";
      this.loop = false;
    }
  }
}
