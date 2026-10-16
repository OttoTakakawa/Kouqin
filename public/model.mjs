export const DEFAULT_KEYS = Object.freeze({
  high: "Shift",
  low: "Control",
  sharp: "Alt",
  longer: "z",
  shorter: "c",
  newline: "Enter",
});
export const STATUSES = ["未练习", "练习中", "熟练"];

export function validateScore(s) {
  if (
    !s ||
    s.version !== 1 ||
    typeof s.id !== "string" ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(s.id) ||
    typeof s.title !== "string" ||
    !s.title.trim() ||
    s.title.length > 200 ||
    !["C", "A"].includes(s.key) ||
    !Number.isFinite(s.bpm) ||
    s.bpm < 30 ||
    s.bpm > 240 ||
    !Array.isArray(s.notes) ||
    s.notes.length > 20000
  ) {
    throw Error("乐谱格式不正确：需要标题、C/A 调、30–240 BPM 和音符列表。");
  }
  if (
    s.category !== undefined &&
    (typeof s.category !== "string" || s.category.length > 100)
  )
    throw Error("分类最长 100 字。");
  if (s.favorite !== undefined && typeof s.favorite !== "boolean")
    throw Error("收藏标记格式不正确。");
  if (s.status !== undefined && !STATUSES.includes(s.status))
    throw Error("练习状态不正确。");
  for (const n of s.notes) {
    if (!n || typeof n !== "object") throw Error("音符不能为空。");
    if (n.type === "break" || n.type === "space") continue;
    if (
      n.type !== "note" ||
      !Number.isInteger(n.degree) ||
      n.degree < 0 ||
      n.degree > 7 ||
      ![-1, 0, 1].includes(n.octave) ||
      typeof n.sharp !== "boolean" ||
      !Number.isFinite(n.duration) ||
      n.duration < 0.125 ||
      n.duration > 8
    )
      throw Error("音符需要 0–7、有效音区和 0.125–8 的音长。");
  }
  return s;
}

export function midi(n, key) {
  if (n.degree === 0) return null;
  return (
    60 +
    [0, 2, 4, 5, 7, 9, 11][n.degree - 1] +
    n.octave * 12 +
    (n.sharp ? 1 : 0) +
    (key === "A" ? -3 : 0)
  );
}
export function frequency(n, key) {
  const value = midi(n, key);
  return value === null ? 0 : 440 * 2 ** ((value - 69) / 12);
}
export function durationChange(value, direction, fine = false) {
  return (
    Math.round(
      Math.min(8, Math.max(0.125, value + direction * (fine ? 0.025 : 0.125))) *
        1000,
    ) / 1000
  );
}
export function label(n) {
  if (n.type === "break") return "↵";
  if (n.type === "space") return " ";
  const d = (n.sharp ? "#" : "") + n.degree;
  return n.octave === 1 ? `[${d}]` : n.octave === -1 ? `(${d})` : d;
}
export function serializeNotation(notes) {
  return notes.map((n) => (n.type === "break" ? "\n" : label(n))).join("");
}

// Reject malformed OCR rather than silently shifting the octave of a whole phrase.
export function parseNotation(text) {
  let octave = 0,
    sharp = false,
    bracket = "";
  const notes = [];
  for (const ch of text.replace(/\r/g, "")) {
    if (ch === "[" || ch === "(") {
      if (bracket) throw Error("括号不能嵌套，请先校对高低音括号。");
      bracket = ch;
      octave = ch === "[" ? 1 : -1;
    } else if (ch === "]" || ch === ")") {
      if (bracket !== (ch === "]" ? "[" : "(") || sharp)
        throw Error("高低音括号没有配对。");
      bracket = "";
      octave = 0;
    } else if (ch === "#") {
      if (sharp) throw Error("重复的推键标记，请校对。");
      sharp = true;
    } else if (/^[0-7]$/.test(ch)) {
      notes.push({
        type: "note",
        degree: Number(ch),
        octave: ch === "0" ? 0 : octave,
        sharp: ch === "0" ? false : sharp,
        duration: 1,
      });
      sharp = false;
    } else if (ch === "\n") {
      if (sharp) throw Error("推键标记后缺少音符。");
      notes.push({ type: "break" });
    } else if (/\s/.test(ch)) {
      if (notes.length && notes.at(-1).type === "note")
        notes.push({ type: "space" });
    } else throw Error("纯谱只接受 0–7、#、高低音括号、空白和换行。");
  }
  if (bracket || sharp) throw Error("存在未闭合括号或缺少音符的推键标记。");
  return notes;
}

export function phraseRange(notes, at) {
  let start = Math.min(at, notes.length),
    end = Math.min(at, notes.length);
  while (start > 0 && notes[start - 1].type !== "break") start--;
  while (end < notes.length && notes[end].type !== "break") end++;
  return { start, end };
}

export function timeline(score, start = 0, end = score.notes.length) {
  let time = 0;
  const events = [];
  for (let i = start; i < end; i++) {
    const n = score.notes[i];
    if (n.type !== "note") continue;
    const duration = (n.duration * 60) / score.bpm;
    events.push({ index: i, note: midi(n, score.key), at: time, duration });
    time += duration;
  }
  return { events, duration: time };
}
