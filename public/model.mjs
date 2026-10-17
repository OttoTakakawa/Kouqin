export const DEFAULT_KEYS = Object.freeze({
  high: "Shift",
  low: "Control",
  sharp: "Alt",
  longer: "z",
  shorter: "c",
  newline: "Enter",
});
export const STATUSES = ["未练习", "练习中", "熟练"];
export const BASE_DURATIONS = Object.freeze([
  { value: 0.125, name: "三十二分音符" },
  { value: 0.25, name: "十六分音符" },
  { value: 0.5, name: "八分音符" },
  { value: 1, name: "四分音符" },
  { value: 2, name: "二分音符" },
  { value: 4, name: "全音符" },
  { value: 8, name: "倍全音符" },
]);
export const NOTE_DURATIONS = Object.freeze(
  [
    ...BASE_DURATIONS,
    ...BASE_DURATIONS.filter((n) => n.value * 1.5 <= 8).map((n) => ({
      value: n.value * 1.5,
      name: "附点" + n.name,
      dotted: true,
    })),
  ].sort((a, b) => a.value - b.value),
);

export function durationName(value) {
  return NOTE_DURATIONS.find((n) => n.value === value)?.name ?? "自定音长";
}
export function durationFraction(value) {
  const basic = new Map([
    [0.125, "1/32"],
    [0.25, "1/16"],
    [0.5, "1/8"],
    [1, "1/4"],
    [2, "1/2"],
    [4, "全音"],
    [8, "倍全"],
  ]);
  if (basic.has(value)) return basic.get(value);
  const dotted = NOTE_DURATIONS.find((n) => n.dotted && n.value === value);
  return dotted ? `${basic.get(value / 1.5)}·` : "自定";
}

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
  if (
    s.durationScale !== undefined &&
    (!Number.isFinite(s.durationScale) ||
      s.durationScale < 0.25 ||
      s.durationScale > 2)
  )
    throw Error("整体音长范围为 0.25–2 倍。");
  for (const n of s.notes) {
    if (!n || typeof n !== "object") throw Error("音符不能为空。");
    if (n.type === "break" || n.type === "space") continue;
    if (
      n.type !== "note" ||
      !Number.isInteger(n.degree) ||
      n.degree < 0 ||
      n.degree > 7 ||
      ![-2, -1, 0, 1, 2].includes(n.octave) ||
      typeof n.sharp !== "boolean" ||
      !Number.isFinite(n.duration) ||
      n.duration < 0.125 ||
      n.duration > 8
    )
      throw Error("音符需要 0–7、有效音区和 0.125–8 的音长。");
    if (
      n.tailHold !== undefined &&
      (!Number.isFinite(n.tailHold) ||
        n.tailHold < 0 ||
        n.tailHold > 4 ||
        n.degree === 0)
    )
      throw Error("尾音拖长需要有声音的音符，范围为 0–4。");
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
export function durationChange(value, direction, withDotted = false) {
  const steps = withDotted ? NOTE_DURATIONS : BASE_DURATIONS;
  return (
    (direction > 0
      ? steps.find((n) => n.value > value + 1e-9)
      : steps.findLast((n) => n.value < value - 1e-9)
    )?.value ?? (direction > 0 ? steps.at(-1).value : steps[0].value)
  );
}
export function label(n) {
  if (n.type === "break") return "↵";
  if (n.type === "space") return " ";
  const d = (n.sharp ? "#" : "") + n.degree;
  return n.octave > 0
    ? "[".repeat(n.octave) + d + "]".repeat(n.octave)
    : n.octave < 0
      ? "(".repeat(-n.octave) + d + ")".repeat(-n.octave)
      : d;
}
export function serializeNotation(notes) {
  return notes.map((n) => (n.type === "break" ? "\n" : label(n))).join("");
}

// Repeated same-kind brackets mark double octaves; mixed or mismatched brackets are ambiguous.
export function parseNotation(text) {
  let octave = 0,
    sharp = false,
    bracket = "";
  const notes = [];
  for (const ch of text.replace(/\r/g, "")) {
    if (ch === "[" || ch === "(") {
      if (bracket && bracket[0] !== ch)
        throw Error("高低音括号不能混合嵌套，请先校对音区。");
      if (bracket.length >= 2) throw Error("音区最多支持倍高音或倍低音。");
      bracket += ch;
      octave += ch === "[" ? 1 : -1;
    } else if (ch === "]" || ch === ")") {
      if (bracket.at(-1) !== (ch === "]" ? "[" : "(") || sharp)
        throw Error("高低音括号没有配对。");
      bracket = bracket.slice(0, -1);
      octave += ch === "]" ? -1 : 1;
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
    const duration =
      ((n.duration + (n.tailHold ?? 0)) * (score.durationScale ?? 1) * 60) /
      score.bpm;
    events.push({ index: i, note: midi(n, score.key), at: time, duration });
    time += duration;
  }
  return { events, duration: time };
}
