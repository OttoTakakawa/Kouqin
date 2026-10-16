import {
  DEFAULT_KEYS,
  validateScore,
  durationChange,
  label,
  parseNotation,
  serializeNotation,
  phraseRange,
  timeline,
} from "./model.mjs";
import { Player } from "./audio.mjs";

const $ = (s) => document.querySelector(s);
const clone = (value) => structuredClone(value);
const draftKey = "harmonica.draft.v1",
  preferencesKey = "harmonica.preferences.v1";
const defaults = {
  keys: { ...DEFAULT_KEYS },
  effects: !matchMedia("(prefers-reduced-motion: reduce)").matches,
  voice: "harmonica",
  volume: 55,
  zoom: 100,
  theme: "ink",
};
let prefs = clone(defaults);
try {
  const saved = JSON.parse(localStorage.getItem(preferencesKey));
  if (saved)
    prefs = { ...prefs, ...saved, keys: { ...DEFAULT_KEYS, ...saved.keys } };
} catch {}
let score,
  nativeScores = [],
  originals = [],
  original = null,
  activeOriginal = null;
let cursor = 0,
  selected = -1,
  range = null,
  dirty = false,
  practice = false,
  viewEpoch = 0,
  version = 0;
let undoStack = [],
  redoStack = [],
  toastTimer,
  draftTimer,
  saving = false,
  requestSaveAgain = false,
  draftProtected = true;
let playingIndex = -1,
  audioState = "stopped";
const player = new Player();

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 4200);
}
async function api(route, options) {
  const res = await fetch(route, options);
  const value = await res.json();
  if (!res.ok) throw Error(value.error || "操作失败");
  return value;
}
function stored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    $("#message").textContent = "本机草稿空间不足，请保存到乐谱库。";
    return false;
  }
}
function persistPreferences() {
  stored(preferencesKey, prefs);
}
function applyPreferences() {
  document.body.dataset.theme = prefs.theme;
  document.body.classList.toggle("no-effects", !prefs.effects);
  document.documentElement.style.setProperty("--zoom", prefs.zoom / 100);
  $("#effects").checked = prefs.effects;
  $("#voice").value = prefs.voice;
  $("#volume").value = prefs.volume;
  player.setVolume(prefs.volume / 100);
  const k = prefs.keys;
  $("#keyboard-help").replaceChildren();
  for (const [key, text] of [
    ["1–7", "输入"],
    [k.high, "高音"],
    [k.low, "低音"],
    [k.sharp, "推键 #"],
    [k.longer.toUpperCase() + " / " + k.shorter.toUpperCase(), "音长"],
    [k.newline, "换行"],
    ["0", "休止"],
  ]) {
    const span = element("span");
    span.append(element("kbd", "", key), document.createTextNode(text));
    $("#keyboard-help").append(span);
  }
}
function fresh(title = "未命名乐谱") {
  return {
    version: 1,
    id: crypto.randomUUID(),
    title,
    key: "C",
    bpm: 90,
    category: "未分类",
    favorite: false,
    status: "未练习",
    notes: [],
  };
}
function saveDraft() {
  clearTimeout(draftTimer);
  if (score && !original)
    draftProtected = stored(draftKey, {
      score,
      dirty,
      cursor,
      selected,
      savedAt: Date.now(),
    });
}
function updateSaveState() {
  $("#save-state").textContent = original
    ? "原有收藏 · 只读"
    : saving
      ? "正在保存…"
      : dirty
        ? draftProtected
          ? "未保存 · 本机草稿已保留"
          : "未保存 · 请立即保存"
        : nativeScores.some((s) => s.id === score?.id)
          ? "已保存到本地"
          : "新乐谱 · 未保存";
  $("#save-state").classList.toggle("dirty", dirty);
  $("#save").disabled = !!original || saving;
  $("#export").disabled = !!original;
}
function change(mutator, { render = true } = {}) {
  if (original) return;
  player.stop();
  undoStack.push({
    score: clone(score),
    cursor,
    selected,
    range: clone(range),
  });
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  mutator();
  version++;
  dirty = true;
  saveDraft();
  updateSaveState();
  if (render) renderEditor();
}
function rememberLeave() {
  saveDraft();
  return (
    !dirty ||
    original ||
    confirm("当前修改尚未保存到乐谱库。要离开吗？\n选择“取消”后可以先保存。")
  );
}
function openScore(next, { restored = false, changed = false } = {}) {
  viewEpoch++;
  player.stop();
  original = null;
  activeOriginal = null;
  score = clone(next);
  cursor = score.notes.length;
  selected = score.notes.findLastIndex((n) => n.type === "note");
  range = null;
  dirty = changed;
  version++;
  undoStack = [];
  redoStack = [];
  if (!restored) saveDraft();
  setDocumentView();
  renderEditor();
  renderLibrary();
}
function setDocumentView() {
  $("#title").value = original ? activeOriginal.title : score.title;
  $("#title").readOnly = !!original;
  $("#category").value = original
    ? activeOriginal.category
    : score.category || "未分类";
  $("#key").value = score?.key || "C";
  $("#bpm").value = score?.bpm || 90;
  $("#status").value = score?.status || "未练习";
  $("#favorite").textContent = !original && score.favorite ? "★" : "☆";
  $("#favorite").setAttribute(
    "aria-pressed",
    String(!original && !!score.favorite),
  );
  $("#breadcrumb").textContent = original
    ? "原有收藏 / " + activeOriginal.category
    : "我的乐谱 / " + (score.category || "未分类");
  $("#original-view").hidden = !original;
  $("#editor-shell").hidden = !!original;
  $("#keyboard-help").hidden = !!original;
  for (const id of [
    "key",
    "category",
    "bpm",
    "status",
    "favorite",
    "play",
    "duplicate",
    "delete",
  ])
    $("#" + id).disabled = !!original;
  updateSaveState();
  updateDuration();
}

function selectedNotes() {
  if (range)
    return score.notes
      .map((n, i) => ({ n, i }))
      .filter(
        ({ n, i }) => n.type === "note" && i >= range.start && i < range.end,
      );
  return score.notes[selected]?.type === "note"
    ? [{ n: score.notes[selected], i: selected }]
    : [];
}
function updateDuration() {
  if (!score) return;
  const notes = selectedNotes();
  $("#selected-label").textContent =
    notes.length > 1
      ? notes.length + " 个"
      : notes[0]
        ? label(notes[0].n)
        : "—";
  $("#note-duration").textContent =
    notes.length === 1 ? Number(notes[0].n.duration.toFixed(3)) : "—";
  $("#lengthen").disabled = $("#shorten").disabled =
    !notes.length || !!original;
  $("#undo").disabled = !undoStack.length;
  $("#redo").disabled = !redoStack.length;
  const duration = timeline(score).duration;
  $("#play-position").textContent = `${clock(0)} / ${clock(duration)}`;
}
function renderEditor() {
  if (!score || original) return;
  const root = $("#score"),
    scroll = root.scrollTop;
  root.replaceChildren();
  const lines = [];
  let start = 0;
  for (let i = 0; i <= score.notes.length; i++)
    if (i === score.notes.length || score.notes[i].type === "break") {
      lines.push({ start, end: i });
      start = i + 1;
    }
  const currentLine = phraseRange(
    score.notes,
    selected >= 0 ? selected : cursor,
  ).start;
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    const row = element(
      "div",
      "phrase" + (line.start === currentLine ? " current" : ""),
    );
    row.dataset.start = line.start;
    row.dataset.end = line.end;
    row.append(
      element("span", "line-number", String(lineNo + 1).padStart(2, "0")),
    );
    for (let i = line.start; i <= line.end; i++) {
      if (cursor === i) row.append(element("span", "caret"));
      if (i === line.end) break;
      const n = score.notes[i],
        chosen = range ? i >= range.start && i < range.end : selected === i;
      const node = element(
        "button",
        (n.type === "space"
          ? "space-token"
          : "note" + (n.degree === 0 ? " rest" : "")) +
          (chosen ? " chosen" : ""),
        label(n),
      );
      node.tabIndex = -1;
      node.dataset.index = i;
      node.setAttribute(
        "aria-label",
        n.type === "space" ? "分组空格" : `${label(n)}，音长 ${n.duration}`,
      );
      node.setAttribute("aria-pressed", String(chosen));
      if (n.type === "note")
        node.style.fontSize =
          ((Math.min(58, Math.max(22, 33 + 13 * Math.log2(n.duration))) *
            prefs.zoom) /
            100) *
            (practice ? 1.23 : 1) +
          "px";
      row.append(node);
    }
    if (line.start === line.end)
      row.append(
        element(
          "span",
          "empty-hint",
          score.notes.length ? "输入下一句…" : "点击这里，按 1–7 开始写谱。",
        ),
      );
    root.append(row);
  }
  root.scrollTop = scroll;
  if (playingIndex >= 0 && (player.playing || player.paused))
    root
      .querySelector(`[data-index="${playingIndex}"]`)
      ?.classList.add("playing");
  $("#note-count").textContent =
    `${score.notes.filter((n) => n.type === "note").length} 个音符 · ${lines.length} 句`;
  updateDuration();
}
function focusScore() {
  $("#score").focus({ preventScroll: true });
}
$("#score").addEventListener("click", (e) => {
  const target = e.target.closest("[data-index]");
  if (target) {
    const index = Number(target.dataset.index);
    range =
      e.shiftKey && selected >= 0
        ? {
            start: Math.min(selected, index),
            end: Math.max(selected, index) + 1,
          }
        : null;
    selected = index;
    cursor = index;
  } else {
    const row = e.target.closest(".phrase");
    if (!row) return;
    cursor = Number(row.dataset.end);
    selected = cursor > Number(row.dataset.start) ? cursor - 1 : -1;
    range = null;
  }
  renderEditor();
  focusScore();
});
function insert(notes) {
  const start = range ? range.start : cursor,
    count = range ? range.end - range.start : 0;
  if (score.notes.length - count + notes.length > 20000)
    return toast("每首最多 20,000 个音符和分隔符。");
  change(() => {
    score.notes.splice(start, count, ...notes);
    cursor = start + notes.length;
    selected = notes.length && notes.at(-1).type === "note" ? cursor - 1 : -1;
    range = null;
  });
  focusScore();
  $("#score .caret")?.scrollIntoView({ block: "nearest" });
}
function adjust(direction, fine = false) {
  const items = selectedNotes();
  if (!items.length) return;
  change(() =>
    items.forEach(
      ({ i }) =>
        (score.notes[i].duration = durationChange(
          score.notes[i].duration,
          direction,
          fine || $("#fine").checked,
        )),
    ),
  );
  focusScore();
}
$("#lengthen").onclick = () => adjust(1);
$("#shorten").onclick = () => adjust(-1);
function undo(redo = false) {
  const from = redo ? redoStack : undoStack,
    to = redo ? undoStack : redoStack;
  if (!from.length || original) return;
  player.stop();
  to.push({ score: clone(score), cursor, selected, range: clone(range) });
  ({ score, cursor, selected, range } = from.pop());
  dirty = true;
  version++;
  saveDraft();
  setDocumentView();
  renderEditor();
  renderLibrary();
  focusScore();
}
$("#undo").onclick = () => undo();
$("#redo").onclick = () => undo(true);
$("#duplicate").onclick = () => {
  const { start, end } = phraseRange(
    score.notes,
    selected >= 0 ? selected : cursor,
  );
  if (start === end) return toast("当前句还没有音符。");
  const copied = clone(score.notes.slice(start, end));
  cursor = end;
  range = null;
  insert([{ type: "break" }, ...copied]);
};

$("#score").addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  const key = e.key.toLowerCase(),
    command = e.ctrlKey || e.metaKey;
  if (command && key === "s") {
    e.preventDefault();
    e.stopPropagation();
    save();
    return;
  }
  if (command && key === "z") {
    e.preventDefault();
    undo(e.shiftKey);
    return;
  }
  if (command && key === "y") {
    e.preventDefault();
    undo(true);
    return;
  }
  if (command && key === "a" && !practice) {
    e.preventDefault();
    range = { start: 0, end: score.notes.length };
    selected = 0;
    cursor = score.notes.length;
    renderEditor();
    return;
  }
  if (key.startsWith("arrow") || e.key === "Home" || e.key === "End") {
    e.preventDefault();
    range = null;
    if (e.key === "ArrowLeft") cursor = Math.max(0, cursor - 1);
    if (e.key === "ArrowRight")
      cursor = Math.min(score.notes.length, cursor + 1);
    const line = phraseRange(score.notes, cursor);
    if (e.key === "Home") cursor = line.start;
    if (e.key === "End") cursor = line.end;
    if (e.key === "ArrowUp") cursor = Math.max(0, line.start - 1);
    if (e.key === "ArrowDown")
      cursor = Math.min(score.notes.length, line.end + 1);
    selected =
      score.notes[cursor]?.type === "note"
        ? cursor
        : score.notes[cursor - 1]?.type === "note"
          ? cursor - 1
          : -1;
    renderEditor();
    $("#score .caret")?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (practice) {
    if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    }
    return;
  }
  const digit = /^(?:Digit|Numpad)([0-7])$/.exec(e.code);
  if (digit) {
    e.preventDefault();
    const degree = Number(digit[1]),
      k = prefs.keys;
    const high = e.getModifierState(k.high),
      low = e.getModifierState(k.low),
      sharp = e.getModifierState(k.sharp);
    if (high && low) return toast("高音与低音不能同时输入。");
    insert([
      {
        type: "note",
        degree,
        octave: degree ? (high ? 1 : low ? -1 : 0) : 0,
        sharp: !!degree && sharp,
        duration: 1,
      },
    ]);
    return;
  }
  if (
    !command &&
    !e.altKey &&
    (key === prefs.keys.longer || key === prefs.keys.shorter)
  ) {
    e.preventDefault();
    adjust(key === prefs.keys.longer ? 1 : -1, e.shiftKey);
    return;
  }
  if (e.key === prefs.keys.newline) {
    e.preventDefault();
    insert([{ type: "break" }]);
    return;
  }
  if (e.code === "Space") {
    e.preventDefault();
    insert([{ type: "space" }]);
    return;
  }
  if (e.key === "Backspace" || e.key === "Delete") {
    e.preventDefault();
    let start = range?.start ?? (e.key === "Backspace" ? cursor - 1 : cursor),
      count = range ? range.end - range.start : 1;
    if (start < 0 || start >= score.notes.length) return;
    change(() => {
      score.notes.splice(start, count);
      cursor = start;
      selected = score.notes[start]?.type === "note" ? start : -1;
      range = null;
    });
  }
});
$("#score").addEventListener("copy", (e) => {
  const notes = range
    ? score.notes.slice(range.start, range.end)
    : selected >= 0
      ? [score.notes[selected]]
      : [];
  if (!notes.length) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", serializeNotation(notes));
  e.clipboardData.setData(
    "application/x-harmonica-notes",
    JSON.stringify(notes),
  );
});
$("#score").addEventListener("paste", (e) => {
  if (practice || original) return;
  e.preventDefault();
  try {
    const data = e.clipboardData.getData("application/x-harmonica-notes");
    const notes = data
      ? JSON.parse(data)
      : parseNotation(e.clipboardData.getData("text/plain"));
    validateScore({ ...score, notes });
    insert(notes);
  } catch (err) {
    toast(err.message);
  }
});

function renderLibrary() {
  const filter = $("#library-filter").value,
    query = $("#search").value.trim().toLocaleLowerCase();
  const all = [
    ...nativeScores.map((s) => ({ ...s, kind: "native" })),
    ...originals.map((s) => ({ ...s, kind: "original" })),
  ];
  const items = all.filter(
    (s) =>
      (!query ||
        (s.title + " " + (s.category || ""))
          .toLocaleLowerCase()
          .includes(query)) &&
      (filter === "all" ||
        filter === s.kind ||
        (filter === "favorite" && s.favorite) ||
        filter === s.status),
  );
  const root = $("#library");
  root.replaceChildren();
  const groups = new Map();
  for (const item of items) {
    const group = item.category || "未分类";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  for (const [name, songs] of groups) {
    const group = element("section", "category-group");
    const heading = element("div", "category-heading");
    heading.append(
      element("span", "", name),
      element("span", "", songs.length),
    );
    group.append(heading);
    for (const item of songs) {
      const active =
        item.kind === "original"
          ? activeOriginal?.id === item.id
          : !original && score?.id === item.id;
      const button = element("button", "song" + (active ? " selected" : ""));
      button.append(
        element(
          "span",
          "song-icon",
          item.kind === "original" ? "▤" : item.favorite ? "★" : "♪",
        ),
        document.createTextNode(item.title),
      );
      button.append(
        element(
          "small",
          "",
          item.kind === "original"
            ? "原有收藏 · 未转谱"
            : (item.status || "未练习") + " · " + item.key + " 调",
        ),
      );
      button.onclick = () => {
        if (!rememberLeave()) return;
        if (item.kind === "original") loadOriginal(item);
        else openScore(item);
        document.body.classList.remove("library-open");
      };
      group.append(button);
    }
    root.append(group);
  }
  if (!items.length) root.append(element("p", "", "没有匹配的乐谱。"));
  $("#library-count").textContent =
    `${nativeScores.length} 首可编辑 · ${originals.length} 首原有收藏`;
  const categories = [...new Set(all.map((s) => s.category || "未分类"))];
  $("#categories").replaceChildren(
    ...categories.map((c) => {
      const option = element("option");
      option.value = c;
      return option;
    }),
  );
}
async function refreshLibrary() {
  const [native, old] = await Promise.all([
    api("/api/scores"),
    api("/api/library"),
  ]);
  nativeScores = native.sort((a, b) =>
    (b.updatedAt || "").localeCompare(a.updatedAt || ""),
  );
  originals = old.items;
  renderLibrary();
  if (old.error) toast(old.error);
}
$("#search").oninput = renderLibrary;
$("#library-filter").onchange = renderLibrary;
$("#refresh").onclick = () => refreshLibrary().catch((e) => toast(e.message));
$("#new-score").onclick = () => {
  if (rememberLeave()) {
    openScore(fresh(), { changed: true });
    document.body.classList.remove("library-open");
    focusScore();
  }
};
async function loadOriginal(item) {
  const epoch = ++viewEpoch;
  player.stop();
  try {
    const result = await api("/api/original?id=" + encodeURIComponent(item.id));
    if (epoch !== viewEpoch) return;
    original = result;
    activeOriginal = item;
    dirty = false;
    setDocumentView();
    renderLibrary();
    $("#original-text").textContent = result.text;
    const images = $("#original-images");
    images.replaceChildren();
    for (const [index, src] of result.images.entries()) {
      const img = element("img");
      img.src = src;
      img.alt = `${item.title} · 原图 ${index + 1}`;
      img.loading = "lazy";
      img.onerror = () =>
        img.replaceWith(
          element("p", "image-error", "这张图片暂时无法读取，可能缺失或重名。"),
        );
      images.append(img);
    }
    if (!result.images.length)
      images.append(
        element("p", "muted", "这份笔记没有引用图片，可展开查看文字。"),
      );
  } catch (err) {
    toast(err.message);
  }
}
async function save() {
  if (original) return;
  if (saving) {
    requestSaveAgain = true;
    return;
  }
  if (!score.title.trim()) {
    score.title = "未命名乐谱";
    $("#title").value = score.title;
  }
  const snapshot = clone(score),
    id = score.id,
    currentVersion = version;
  try {
    validateScore(snapshot);
    saving = true;
    updateSaveState();
    const result = await api("/api/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    snapshot.updatedAt = result.updatedAt;
    nativeScores = [snapshot, ...nativeScores.filter((s) => s.id !== id)];
    if (!original && score.id === id) {
      score.updatedAt = result.updatedAt;
      if (currentVersion === version) dirty = false;
      saveDraft();
      $("#message").textContent =
        "已保存 " + new Date(result.updatedAt).toLocaleTimeString();
    }
    renderLibrary();
  } catch (err) {
    toast("保存失败：" + err.message);
  } finally {
    saving = false;
    updateSaveState();
    if (requestSaveAgain) {
      requestSaveAgain = false;
      save();
    }
  }
}
$("#save").onclick = save;
$("#title").addEventListener("input", (e) =>
  change(() => (score.title = e.target.value), { render: false }),
);
$("#category").addEventListener("change", (e) => {
  change(() => (score.category = e.target.value.trim() || "未分类"), {
    render: false,
  });
  $("#breadcrumb").textContent = "我的乐谱 / " + score.category;
  renderLibrary();
});
$("#key").onchange = (e) => change(() => (score.key = e.target.value));
$("#status").onchange = (e) =>
  change(() => (score.status = e.target.value), { render: false });
$("#favorite").onclick = () => {
  change(() => (score.favorite = !score.favorite), { render: false });
  $("#favorite").textContent = score.favorite ? "★" : "☆";
  $("#favorite").setAttribute("aria-pressed", String(score.favorite));
};
$("#bpm").onchange = (e) => {
  const value = Number(e.target.value);
  if (!Number.isFinite(value) || value < 30 || value > 240) {
    e.target.value = score.bpm;
    return toast("速度范围为 30–240 BPM。");
  }
  change(() => (score.bpm = value));
};
$("#export").onclick = () => {
  if (original) return;
  const blob = new Blob([JSON.stringify(score, null, 2)], {
      type: "application/json",
    }),
    url = URL.createObjectURL(blob);
  const link = element("a");
  link.href = url;
  link.download =
    (score.title.replace(/[<>:"/\\|?*]/g, "_") || "乐谱") + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$("#delete").onclick = async () => {
  if (original) return;
  const exists = nativeScores.some((s) => s.id === score.id);
  if (
    !confirm(
      exists
        ? "删除这首乐谱？文件会移到本机 data/trash，原有收藏不受影响。"
        : "放弃这份未保存的新谱？",
    )
  )
    return;
  try {
    if (exists) await api("/api/scores/" + score.id, { method: "DELETE" });
    nativeScores = nativeScores.filter((s) => s.id !== score.id);
    openScore(fresh());
    toast("乐谱已移除。");
  } catch (err) {
    toast(err.message);
  }
};

function showImport(text = "") {
  $("#import-text").value = text;
  $("#import-file").value = "";
  $("#import-error").textContent = "";
  $("#import-dialog").showModal();
}
$("#import-open").onclick = () => showImport();
$("#original-import").onclick = () => {
  const part = original.text.split("### 识别出的简谱")[1];
  const text = part?.match(/```(?:text)?\s*\n([\s\S]*?)```/)?.[1] || "";
  showImport(text);
  if (!text)
    $("#import-error").textContent = "没有找到简谱草稿，请粘贴数字谱或 JSON。";
};
$("#import-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 2e6) {
    $("#import-error").textContent = "导入文件不能超过 2 MB。";
    return;
  }
  try {
    $("#import-text").value = await file.text();
  } catch (err) {
    $("#import-error").textContent = err.message;
  }
};
$("#import-form").onsubmit = (e) => {
  e.preventDefault();
  try {
    const text = $("#import-text").value.trim();
    if (!text) throw Error("先输入乐谱内容。");
    let next;
    if (
      text.startsWith("{") ||
      (text.startsWith("[") && !/^\[[#0-7\s]+\]/.test(text))
    ) {
      const parsed = JSON.parse(text);
      next = Array.isArray(parsed)
        ? { ...fresh(), notes: parsed }
        : { ...parsed, id: crypto.randomUUID() };
      validateScore(next);
    } else {
      next = {
        ...fresh(activeOriginal?.title || "导入乐谱"),
        notes: parseNotation(text),
      };
      validateScore(next);
    }
    if (!next.notes.some((n) => n.type === "note"))
      throw Error("导入内容没有音符。");
    if (!rememberLeave()) return;
    openScore(next, { changed: true });
    $("#import-dialog").close();
    focusScore();
    toast("已导入草稿。请试听并校对音高、音长。");
  } catch (err) {
    $("#import-error").textContent = err.message;
  }
};
document
  .querySelectorAll(".close-dialog")
  .forEach((b) => (b.onclick = () => b.closest("dialog").close()));

function settingsValues(keys) {
  for (const [name, value] of Object.entries(keys))
    $("#settings-form").elements.namedItem(name).value = value;
}
$("#settings-open").onclick = () => {
  settingsValues(prefs.keys);
  $("#theme").value = prefs.theme;
  $("#zoom").value = prefs.zoom;
  $("#settings-error").textContent = "";
  $("#settings-dialog").showModal();
};
$("#reset-keys").onclick = () => settingsValues(DEFAULT_KEYS);
$("#settings-form").onsubmit = (e) => {
  e.preventDefault();
  const form = new FormData(e.target),
    keys = Object.fromEntries(form);
  keys.longer = keys.longer.trim().toLowerCase();
  keys.shorter = keys.shorter.trim().toLowerCase();
  if (new Set([keys.high, keys.low, keys.sharp]).size !== 3) {
    $("#settings-error").textContent = "高音、低音、推键请使用不同的修饰键。";
    return;
  }
  if (
    !/^[a-z]$/.test(keys.longer) ||
    !/^[a-z]$/.test(keys.shorter) ||
    keys.longer === keys.shorter
  ) {
    $("#settings-error").textContent = "延长和缩短请设置为两个不同的英文字母。";
    return;
  }
  prefs.keys = keys;
  prefs.theme = $("#theme").value;
  prefs.zoom = Number($("#zoom").value);
  persistPreferences();
  applyPreferences();
  renderEditor();
  $("#settings-dialog").close();
  toast("设置已保存。");
};
$("#effects").onchange = (e) => {
  prefs.effects = e.target.checked;
  persistPreferences();
  applyPreferences();
};
$("#volume").oninput = (e) => {
  prefs.volume = Number(e.target.value);
  player.setVolume(prefs.volume / 100);
  persistPreferences();
};
$("#voice").onchange = (e) => {
  player.stop();
  prefs.voice = e.target.value;
  persistPreferences();
};
function setMode(value) {
  practice = value;
  document.body.classList.toggle("practice", practice);
  document.body.classList.remove("library-open");
  $("#edit-mode").classList.toggle("active", !value);
  $("#practice-mode").classList.toggle("active", value);
  renderEditor();
}
$("#edit-mode").onclick = () => setMode(false);
$("#practice-mode").onclick = () => setMode(true);
const menu = element("button", "icon menu-toggle", "☰");
menu.setAttribute("aria-label", "显示或隐藏乐谱库");
menu.onclick = () => document.body.classList.toggle("library-open");
$("header").prepend(menu);
document.addEventListener("click", (e) => {
  if (!e.target.closest(".sidebar") && !e.target.closest(".menu-toggle"))
    document.body.classList.remove("library-open");
});

function clock(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return (
    String(Math.floor(value / 60)).padStart(2, "0") +
    ":" +
    String(value % 60).padStart(2, "0")
  );
}
player.onState = (state) => {
  audioState = state;
  $("#play").textContent =
    state === "loading"
      ? "加载音色…"
      : state === "playing"
        ? "Ⅱ 暂停"
        : state === "paused"
          ? "▶ 继续"
          : "▶ 播放";
  $("#play").setAttribute(
    "aria-label",
    state === "playing" ? "暂停" : state === "paused" ? "继续" : "播放",
  );
  $("#play").disabled = !!original || state === "loading";
};
player.onFrame = (time, duration, index) => {
  if (!score || original) return;
  $("#play-position").textContent =
    `${clock(time)} / ${clock(duration || timeline(score).duration)}`;
  if (playingIndex === index) return;
  document
    .querySelectorAll(".note.playing")
    .forEach((n) => n.classList.remove("playing"));
  playingIndex = index;
  if (index >= 0) {
    const node = $(`.note[data-index="${index}"]`);
    node?.classList.add("playing");
    node?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }
};
async function togglePlay() {
  if (original || audioState === "loading") return;
  try {
    if (player.playing) player.pause();
    else if (player.paused) await player.resume();
    else {
      const region =
        $("#scope").value === "phrase"
          ? phraseRange(score.notes, selected >= 0 ? selected : cursor)
          : { start: 0, end: score.notes.length };
      await player.start(clone(score), {
        ...region,
        voice: prefs.voice,
        loop: $("#loop").checked,
      });
    }
  } catch (err) {
    toast(err.message);
  }
}
$("#play").onclick = togglePlay;
$("#stop").onclick = () => player.stop();
$("#scope").onchange = () => player.stop();
$("#loop").onchange = (e) => (player.loop = e.target.checked);
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
  if (e.key === "Escape") {
    player.stop();
    document.body.classList.remove("library-open");
  }
});
window.addEventListener("beforeunload", (e) => {
  saveDraft();
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) saveDraft();
});

applyPreferences();
try {
  await refreshLibrary();
  let draft;
  try {
    draft = JSON.parse(localStorage.getItem(draftKey));
    if (draft) validateScore(draft.score);
  } catch {
    draft = null;
  }
  if (draft && draft.dirty) {
    openScore(draft.score, { restored: true, changed: true });
    toast("已恢复上次未保存的本机草稿。");
  } else if (draft && nativeScores.some((s) => s.id === draft.score.id))
    openScore(nativeScores.find((s) => s.id === draft.score.id));
  else if (nativeScores.length) openScore(nativeScores[0]);
  else openScore(fresh());
} catch (err) {
  openScore(fresh());
  toast("读取乐谱库失败：" + err.message + "。可以先写谱，连接恢复后再保存。");
}
