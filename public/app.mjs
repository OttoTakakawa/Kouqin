import {
  DEFAULT_KEYS,
  validateScore,
  durationChange,
  durationName,
  durationFraction,
  NOTE_DURATIONS,
  label,
  parseNotation,
  serializeNotation,
  phraseRange,
  timeline,
} from "./model.mjs";
import { Player } from "./audio.mjs";
import { PlaybackRange } from "./transport.mjs";

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
  sidebarCollapsed: false,
  foldedCategories: [],
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
const playback = new PlaybackRange();
let playbackBaseTime = 0;

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
  document.body.classList.toggle("sidebar-collapsed", !!prefs.sidebarCollapsed);
  updateLibraryToggle();
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
    ["Shift+点击", "多选"],
    ["Ctrl+A", "全选"],
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
  const resumeLoop = player.playing && playback.loop;
  player.stop();
  undoStack.push({
    score: playback.copyScore(score),
    cursor,
    selected,
    range: clone(range),
  });
  if (undoStack.length > 60) undoStack.shift();
  redoStack = [];
  const previousNotes = score.notes.slice();
  mutator();
  playback.rebase(previousNotes, score.notes);
  version++;
  dirty = true;
  saveDraft();
  updateSaveState();
  updatePlaybackControls();
  if (render) renderEditor();
  if (resumeLoop) startPlayback().catch((err) => toast(err.message));
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
  playback.reset(score.notes);
  playbackBaseTime = 0;
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
  $("#status").value = score?.status || "未练习";
  $("#favorite").textContent = !original && score.favorite ? "★" : "☆";
  $("#favorite").setAttribute(
    "aria-pressed",
    String(!original && !!score.favorite),
  );
  $("#restore-archive").hidden = !!original || score.archived !== true;
  $("#breadcrumb").textContent = original
    ? "原有收藏 / " + activeOriginal.category
    : "我的乐谱 / " + (score.category || "未分类");
  $("#original-view").hidden = !original;
  $("#editor-shell").hidden = !!original;
  $("#keyboard-help").hidden = !!original;
  for (const id of [
    "key",
    "category",
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
function selectedRhythmItems() {
  const notes = selectedNotes();
  if (notes.length) return notes;
  return score.notes
    .map((n, i) => ({ n, i }))
    .filter(
      ({ n, i }) =>
        n.type === "space" &&
        (range ? i >= range.start && i < range.end : i === selected),
    );
}
function rhythmDuration(n) {
  return n.type === "space" ? 0 : n.duration;
}
function setRhythmDuration({ n, i }, value) {
  if (n.type === "space" && value > 0)
    score.notes[i] = {
      type: "note",
      degree: 0,
      octave: 0,
      sharp: false,
      duration: value,
    };
  else if (n.type === "note") n.duration = value;
}
function setSelectedDuration(value) {
  const items = selectedRhythmItems();
  if (
    original ||
    !items.length ||
    !Number.isFinite(value) ||
    value < 0.125 ||
    value > 8
  )
    return;
  if (items.every(({ n }) => rhythmDuration(n) === value)) return;
  const cuePause =
    items.length === 1 && items[0].n.type === "space" && value > 0;
  change(() => items.forEach((item) => setRhythmDuration(item, value)));
  if (cuePause) seekPlayback(items[0].i);
  focusScore();
}
function phraseEnding() {
  const items = selectedNotes();
  const last = items.at(-1);
  const voiced = items.findLast(({ n }) => n.degree > 0);
  let pause = last?.n.degree === 0 ? last.i : (last?.i ?? -1) + 1;
  while (score.notes[pause]?.type === "space") pause++;
  if (score.notes[pause]?.type !== "note" || score.notes[pause].degree !== 0)
    pause = -1;
  return { last, voiced, pause };
}
function setPhraseEnding(kind, value) {
  if (original) return;
  const items = selectedRhythmItems();
  if (
    kind === "pause" &&
    items.length &&
    items.every(({ n }) => n.type === "space")
  ) {
    setSelectedDuration(value);
    $("#pause-menu").open = false;
    return;
  }
  const ending = phraseEnding();
  if (kind === "hold") {
    if (!ending.voiced) return;
    change(() => {
      if (value) ending.voiced.n.tailHold = value;
      else delete ending.voiced.n.tailHold;
    });
  } else {
    if (!ending.last) return;
    if (!value && ending.pause < 0) return;
    if (value && ending.pause < 0 && score.notes.length >= 20000)
      return toast("这首乐谱已达到音符数量上限。");
    const extendLoop = value && playback.b === ending.last.i;
    const pauseIndex = ending.pause >= 0 ? ending.pause : ending.last.i + 1;
    change(() => {
      if (ending.pause >= 0) {
        if (value) score.notes[ending.pause].duration = value;
        else {
          score.notes.splice(ending.pause, 1);
          selected = ending.voiced?.i ?? Math.max(0, ending.pause - 1);
          cursor = selected;
          range = null;
        }
      } else {
        const index = ending.last.i + 1;
        score.notes.splice(index, 0, {
          type: "note",
          degree: 0,
          octave: 0,
          sharp: false,
          duration: value,
        });
        selected = cursor = index;
        range = null;
      }
    });
    if (extendLoop && playback.complete) {
      playback.b = pauseIndex;
      renderEditor();
    }
  }
  document
    .querySelectorAll(".note-menu[open]")
    .forEach((menu) => (menu.open = false));
  focusScore();
}
function updateDuration() {
  if (!score) return;
  updatePlaybackSpeed(original ? 90 : score.bpm / (score.durationScale ?? 1));
  const notes = selectedRhythmItems();
  const pausesOnly =
    notes.length &&
    notes.every(({ n }) => n.type === "space" || n.degree === 0);
  const spacesOnly = notes.length && notes.every(({ n }) => n.type === "space");
  $("#selection-caption").textContent = pausesOnly
    ? notes.length > 1
      ? "已选停顿"
      : "当前停顿"
    : notes.length > 1
      ? "已选音符"
      : "当前音符";
  $("#selected-label").textContent =
    notes.length > 1
      ? notes.length + " 个"
      : notes[0]
        ? pausesOnly
          ? "停"
          : label(notes[0].n)
        : "—";
  const sameDuration =
    notes.length &&
    notes.every(({ n }) => rhythmDuration(n) === rhythmDuration(notes[0].n));
  if ($("#duration-feel")) {
    const d = notes.length ? rhythmDuration(notes[0].n) : undefined;
    const common = [0.25, 0.5, 1, 2, 4].includes(d);
    $("#duration-feel").setAttribute(
      "aria-label",
      pausesOnly ? "停顿时长" : "音长",
    );
    const custom = $('#duration-feel option[value=""]');
    custom.textContent = !notes.length
      ? "音长"
      : !sameDuration
        ? "混合"
        : d === 0
          ? "设为休止"
          : durationFraction(d);
    $("#duration-feel").value = sameDuration && common ? d : "";
    $("#duration-feel").disabled = !!original || !notes.length;
    const ending = phraseEnding();
    document
      .querySelectorAll("[data-hold]")
      .forEach(
        (b) =>
          (b.disabled =
            !!original ||
            !ending.voiced ||
            (Number(b.dataset.hold) === 0 && !ending.voiced.n.tailHold)),
      );
    document
      .querySelectorAll("[data-pause]")
      .forEach(
        (b) =>
          (b.disabled =
            !!original ||
            (!ending.last && !spacesOnly) ||
            (Number(b.dataset.pause) === 0 &&
              (ending.pause < 0 || spacesOnly))),
      );
    $("#tail-menu summary").setAttribute(
      "aria-disabled",
      String(!ending.voiced || !!original),
    );
    $("#pause-menu summary").setAttribute(
      "aria-disabled",
      String((!ending.last && !spacesOnly) || !!original),
    );
  }
  $("#note-duration").textContent = sameDuration
    ? Number(rhythmDuration(notes[0].n).toFixed(4))
    : notes.length
      ? "混合"
      : "—";
  $("#note-duration-name").textContent = sameDuration
    ? rhythmDuration(notes[0].n) === 0
      ? "旧谱分隔 · 不占拍"
      : `拍 · ${durationName(rhythmDuration(notes[0].n))}`
    : "";
  $("#batch-duration-tools").hidden = !notes.length || !!original;
  $("#set-duration-label").textContent = notes.length > 1 ? "统一为" : "设为";
  $("#batch-duration").disabled = $("#apply-batch-duration").disabled =
    !notes.length || !!original;
  const standard =
    notes.length &&
    NOTE_DURATIONS.some((n) => n.value === rhythmDuration(notes[0].n));
  $("#batch-duration").value = standard ? rhythmDuration(notes[0].n) : "";
  $("#apply-batch-duration").disabled = !!original || !standard;
  const phrase = phraseRange(score.notes, selected >= 0 ? selected : cursor);
  $("#select-phrase").disabled =
    !!original ||
    !score.notes.slice(phrase.start, phrase.end).some((n) => n.type === "note");
  $("#lengthen").disabled = $("#shorten").disabled =
    !notes.length || !!original;
  $("#undo").disabled = !undoStack.length;
  $("#redo").disabled = !redoStack.length;
  updatePlaybackControls();
}
function updatePlaybackSpeed(value) {
  const slider = $("#duration-scale");
  // Extend only for legacy scores outside the normal range; never alter their sound on load.
  slider.min = Math.min(30, value);
  slider.max = Math.max(240, value);
  slider.value = value;
  slider.disabled = !!original;
  slider.setAttribute("aria-valuetext", `${Number(value.toFixed(2))} BPM`);
  $("#duration-scale-value").textContent = `${Number(value.toFixed(2))} BPM`;
  $("#tempo-preset").value = [60, 90, 120, 160].includes(value)
    ? String(value)
    : "";
  $("#tempo-preset").disabled = !!original;
}
function setPlaybackSpeed(value) {
  if (original) return;
  if (!Number.isFinite(value) || value < 15 || value > 960) {
    updateDuration();
    return;
  }
  if (value !== score.bpm / (score.durationScale ?? 1))
    change(
      () => {
        score.bpm = Math.min(240, Math.max(30, value));
        const scale = score.bpm / value;
        if (scale === 1) delete score.durationScale;
        else score.durationScale = scale;
      },
      { render: false },
    );
  updateDuration();
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
    practice ? Math.max(0, playback.cursor) : selected >= 0 ? selected : cursor,
  ).start;
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    const row = element(
      "div",
      "phrase" +
        (line.start === currentLine ? " current" : "") +
        (!practice && range?.start === line.start && range?.end === line.end
          ? " row-selected"
          : ""),
    );
    row.dataset.start = line.start;
    row.dataset.end = line.end;
    const lineNumber = element(
      "button",
      "line-number",
      String(lineNo + 1).padStart(2, "0"),
    );
    lineNumber.type = "button";
    lineNumber.tabIndex = -1;
    lineNumber.setAttribute("aria-label", `选择第 ${lineNo + 1} 句`);
    lineNumber.setAttribute(
      "aria-pressed",
      String(row.classList.contains("row-selected")),
    );
    lineNumber.title = "点击选中整句，再点从句首播放";
    row.append(lineNumber);
    for (let i = line.start; i <= line.end; i++) {
      if (cursor === i && !range) row.append(element("span", "caret"));
      if (i === line.end) break;
      const n = score.notes[i],
        chosen =
          !practice &&
          (range ? i >= range.start && i < range.end : selected === i);
      const node = element(
        "button",
        (n.type === "space"
          ? "space-token"
          : "note" + (n.degree === 0 ? " rest" : "")) +
          (chosen ? " chosen" : ""),
        n.type === "space" ? "·" : n.degree === 0 ? "停" : label(n),
      );
      node.tabIndex = -1;
      node.dataset.index = i;
      if (n.type === "note") {
        node.classList.toggle("tail-hold", !!n.tailHold);
        node.classList.toggle("pause-token", n.degree === 0);
        node.classList.toggle("playback-cursor", i === playback.cursor);
        node.classList.toggle(
          "loop-range",
          playback.complete && i >= playback.a && i <= playback.b,
        );
        const marker = [
          i === playback.a ? "A" : "",
          i === playback.b ? "B" : "",
        ]
          .filter(Boolean)
          .join("·");
        if (marker) node.dataset.loopMarker = marker;
      }
      node.setAttribute(
        "aria-label",
        n.type === "space"
          ? "旧谱分隔，不占拍；选择时长可转为休止"
          : n.degree === 0
            ? `停，${durationFraction(n.duration)}，${n.duration}拍`
            : `${label(n)}，音长 ${n.duration}${n.tailHold ? "，尾音拖住" : ""}`,
      );
      node.setAttribute("aria-pressed", String(chosen));
      if (n.type === "space")
        node.title = "旧谱分隔；选择时长可转为休止，删除键可移除";
      if (n.type === "note")
        node.style.fontSize =
          ((Math.min(
            58,
            Math.max(
              18,
              33 +
                (n.duration + (n.tailHold ?? 0) < 1 ? 5 : 10) *
                  Math.log2(n.duration + (n.tailHold ?? 0)),
            ),
          ) *
            prefs.zoom) /
            100) *
            (practice ? 1.23 : 1) +
          "px";
      if (n.type === "note" && n.degree === 0) {
        node.style.fontSize = "16px";
        node.style.minWidth = `${Math.min(90, 30 + 15 * Math.max(0, Math.log2(n.duration)))}px`;
        node.title = `停 ${n.duration} 拍（${durationFraction(n.duration)}），点击可调整`;
      }
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
function refreshScoreSelection() {
  const root = $("#score");
  const currentLine = phraseRange(
    score.notes,
    practice ? Math.max(0, playback.cursor) : selected >= 0 ? selected : cursor,
  ).start;
  for (const row of root.querySelectorAll(".phrase")) {
    row.classList.toggle("current", Number(row.dataset.start) === currentLine);
    const selectedRow =
      !practice &&
      range?.start === Number(row.dataset.start) &&
      range?.end === Number(row.dataset.end);
    row.classList.toggle("row-selected", selectedRow);
    row
      .querySelector(".line-number")
      .setAttribute("aria-pressed", String(selectedRow));
  }
  for (const node of root.querySelectorAll("[data-index]")) {
    const index = Number(node.dataset.index);
    const chosen =
      !practice &&
      (range ? index >= range.start && index < range.end : index === selected);
    node.classList.toggle("chosen", chosen);
    node.setAttribute("aria-pressed", String(chosen));
    if (node.classList.contains("note")) {
      node.classList.toggle("playback-cursor", index === playback.cursor);
      node.classList.toggle(
        "loop-range",
        playback.complete && index >= playback.a && index <= playback.b,
      );
    }
  }
  root.querySelectorAll(".caret").forEach((n) => n.remove());
  if (!practice && !range) {
    const caret = element("span", "caret"),
      next = root.querySelector(`[data-index="${cursor}"]`);
    if (next) next.before(caret);
    else
      [...root.querySelectorAll(".phrase")]
        .find((row) => Number(row.dataset.end) === cursor)
        ?.append(caret);
  }
  updateDuration();
}
$("#score").addEventListener("click", (e) => {
  const lineNumber = e.target.closest(".line-number");
  if (lineNumber) {
    const row = lineNumber.closest(".phrase"),
      start = Number(row.dataset.start),
      end = Number(row.dataset.end);
    const firstNote = score.notes.findIndex(
      (n, i) => i >= start && i < end && n.type === "note",
    );
    const replay =
      firstNote >= 0 &&
      (practice
        ? playback.cursor === firstNote
        : range?.start === start && range?.end === end);
    if (firstNote >= 0)
      seekPlayback(firstNote, { render: false, restart: !replay });
    if (!practice) {
      range = firstNote >= 0 ? { start, end } : null;
      selected = firstNote;
      cursor = end;
    }
    refreshScoreSelection();
    focusScore();
    if (replay) startPlayback().catch((err) => toast(err.message));
    return;
  }
  const target = e.target.closest("[data-index]");
  if (target) {
    const index = Number(target.dataset.index);
    if (practice) {
      seekPlayback(index);
      focusScore();
      return;
    }
    range =
      e.shiftKey && selected >= 0
        ? {
            start: Math.min(selected, index),
            end: Math.max(selected, index) + 1,
          }
        : null;
    selected = index;
    cursor = index;
    if (!e.shiftKey) seekPlayback(index, { render: false });
  } else {
    const row = e.target.closest(".phrase");
    if (!row) return;
    if (practice) {
      seekPlayback(Number(row.dataset.start));
      focusScore();
      return;
    }
    cursor = Number(row.dataset.end);
    selected = cursor > Number(row.dataset.start) ? cursor - 1 : -1;
    range = null;
  }
  refreshScoreSelection();
  focusScore();
});
$("#score").addEventListener("dblclick", (e) => {
  const target = e.target.closest(".note");
  if (target && !e.shiftKey) startPlayback().catch((err) => toast(err.message));
});
function insert(notes, { replaceSelection = true } = {}) {
  const start = range ? (replaceSelection ? range.start : range.end) : cursor,
    count = range && replaceSelection ? range.end - range.start : 0;
  if (score.notes.length - count + notes.length > 20000)
    return toast("每首最多 20,000 个音符和分隔符。");
  change(() => {
    score.notes.splice(start, count, ...notes);
    cursor = start + notes.length;
    selected =
      notes.length && ["note", "space"].includes(notes.at(-1).type)
        ? cursor - 1
        : -1;
    range = null;
  });
  focusScore();
  $("#score .caret")?.scrollIntoView({ block: "nearest" });
}
function adjust(direction, withDotted = false) {
  const items = selectedRhythmItems();
  if (!items.length) return;
  const durations = items.map(({ n }) =>
    rhythmDuration(n) === 0 && direction < 0
      ? 0
      : durationChange(
          rhythmDuration(n),
          direction,
          withDotted || $("#dotted-steps").checked,
        ),
  );
  if (items.every(({ n }, i) => rhythmDuration(n) === durations[i])) return;
  const cuePause =
    items.length === 1 && items[0].n.type === "space" && durations[0] > 0;
  change(() =>
    items.forEach((item, i) => setRhythmDuration(item, durations[i])),
  );
  if (cuePause) seekPlayback(items[0].i);
  focusScore();
}
$("#lengthen").onclick = () => adjust(1);
$("#shorten").onclick = () => adjust(-1);
function applyBatchDuration() {
  const items = selectedRhythmItems();
  if (original || !items.length) return;
  const value = Number($("#batch-duration").value);
  if (!NOTE_DURATIONS.some((n) => n.value === value)) {
    toast("请选择一个标准音长。");
    $("#batch-duration").focus();
    return;
  }
  setSelectedDuration(value);
  focusScore();
}
$("#apply-batch-duration").onclick = applyBatchDuration;
for (const dotted of [false, true]) {
  const group = element("optgroup");
  group.label = dotted ? "附点（延长一半）" : "常用音长（四分音符为 1 拍）";
  for (const n of NOTE_DURATIONS.filter((n) => !!n.dotted === dotted)) {
    const option = element("option", "", `${n.name} · ${n.value}拍`);
    option.value = n.value;
    group.append(option);
  }
  $("#batch-duration").append(group);
}
$("#batch-duration").onchange = (e) => {
  $("#apply-batch-duration").disabled = !NOTE_DURATIONS.some(
    (n) => n.value === Number(e.target.value),
  );
};
$("#batch-duration").onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    applyBatchDuration();
  }
};
$("#select-phrase").onclick = () => {
  if (original) return;
  const phrase = phraseRange(score.notes, selected >= 0 ? selected : cursor);
  range = phrase;
  selected = score.notes.findIndex(
    (n, i) => i >= phrase.start && i < phrase.end && n.type === "note",
  );
  cursor = phrase.end;
  renderEditor();
  focusScore();
};
function undo(redo = false) {
  const from = redo ? redoStack : undoStack,
    to = redo ? undoStack : redoStack;
  if (!from.length || original) return;
  player.stop();
  to.push({
    score: playback.copyScore(score),
    cursor,
    selected,
    range: clone(range),
  });
  const snapshot = from.pop();
  const previousNotes = score.notes;
  ({ score, cursor, selected, range } = snapshot);
  playback.rebase(previousNotes, score.notes);
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
  if (practice) {
    if (key.startsWith("arrow") || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const notes = score.notes.flatMap((n, i) =>
        n.type === "note" ? [i] : [],
      );
      const at = Math.max(0, notes.indexOf(playback.cursor));
      const phrase = phraseRange(score.notes, Math.max(0, playback.cursor));
      let index = playback.cursor;
      if (e.key === "ArrowLeft") index = notes[Math.max(0, at - 1)];
      if (e.key === "ArrowRight")
        index = notes[Math.min(notes.length - 1, at + 1)];
      if (e.key === "Home") index = phrase.start;
      if (e.key === "End") index = notes.findLast((i) => i < phrase.end);
      if (e.key === "ArrowUp")
        index = notes.findLast((i) => i < phrase.start) ?? notes[0];
      if (e.key === "ArrowDown")
        index = Math.min(score.notes.length - 1, phrase.end + 1);
      seekPlayback(index ?? 0);
    } else if (e.code === "Space") {
      e.preventDefault();
      togglePlay();
    }
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
    insert(
      [{ type: "note", degree: 0, octave: 0, sharp: false, duration: 1 }],
      { replaceSelection: false },
    );
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

function convertedScore(item) {
  return nativeScores.find((s) => {
    if (s.archived === true) return false;
    const source = s.transcription?.sourceRelativePath;
    return source
      ? source.replaceAll("\\", "/") ===
          `${item.category ? item.category + "/" : ""}${item.title}.md`
      : s.title === item.title;
  });
}
function renderLibrary() {
  const filter = $("#library-filter").value,
    query = $("#search").value.trim().toLocaleLowerCase();
  const all = [
    ...nativeScores.map((s) => ({ ...s, kind: "native" })),
    ...originals.map((s) => ({ ...s, kind: "original" })),
  ];
  const items = all.filter((s) => {
    if (
      s.kind === "native" &&
      (s.archived === true) !== (filter === "archived")
    )
      return false;
    if (filter === "all" && s.kind === "original" && convertedScore(s))
      return false;
    return (
      (!query ||
        (s.title + " " + (s.category || ""))
          .toLocaleLowerCase()
          .includes(query)) &&
      (filter === "all" ||
        (filter === "archived" && s.kind === "native") ||
        filter === s.kind ||
        (filter === "favorite" && s.favorite) ||
        filter === s.status)
    );
  });
  const root = $("#library");
  root.replaceChildren();
  const groups = new Map();
  for (const item of items) {
    const group = item.category || "未分类";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  for (const [name, songs] of groups) {
    const group = element("details", "category-group");
    group.open = !!query || !prefs.foldedCategories.includes(name);
    group.addEventListener("toggle", () => {
      if (!group.isConnected || query) return;
      const folded = new Set(prefs.foldedCategories);
      if (group.open) folded.delete(name);
      else folded.add(name);
      prefs.foldedCategories = [...folded];
      persistPreferences();
    });
    const heading = element("summary", "category-heading");
    heading.append(
      element("span", "", name),
      element("span", "", songs.length),
    );
    group.append(heading);
    for (const item of songs) {
      const converted = item.kind === "original" && convertedScore(item);
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
            ? converted
              ? "原有收藏 · 已有可编辑谱"
              : "原有收藏 · 未转谱"
            : (item.archived === true ? "归档版本" : item.status || "未练习") +
                " · " +
                item.key +
                " 调",
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
    `${nativeScores.filter((s) => s.archived !== true).length} 首可编辑 · ${originals.length} 首原有收藏`;
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
$("#restore-archive").onclick = async () => {
  if (original || score.archived !== true) return;
  change(() => {
    delete score.archived;
    delete score.archivedAt;
    delete score.archiveReason;
    delete score.primaryScoreId;
  });
  setDocumentView();
  await save();
  if (!dirty) {
    $("#library-filter").value = "native";
    renderLibrary();
    toast("已恢复到乐谱列表。");
  }
};
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
$("#duration-scale").oninput = (e) =>
  updatePlaybackSpeed(Number(e.target.value));
$("#duration-scale").onchange = (e) => setPlaybackSpeed(Number(e.target.value));
$("#tempo-preset").onchange = (e) => {
  if (e.target.value) setPlaybackSpeed(Number(e.target.value));
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
function updateLibraryToggle() {
  if (!$(".menu-toggle")) return;
  const expanded = matchMedia("(max-width: 768px)").matches
    ? document.body.classList.contains("library-open")
    : !prefs.sidebarCollapsed && !practice;
  $(".menu-toggle").setAttribute("aria-expanded", String(expanded));
  $(".menu-toggle").title = expanded ? "收起乐谱列表" : "展开乐谱列表";
}
menu.onclick = () => {
  if (matchMedia("(max-width: 768px)").matches)
    document.body.classList.toggle("library-open");
  else {
    prefs.sidebarCollapsed = !prefs.sidebarCollapsed;
    document.body.classList.toggle("sidebar-collapsed", prefs.sidebarCollapsed);
    persistPreferences();
  }
  updateLibraryToggle();
};
$("header").prepend(menu);
matchMedia("(max-width: 768px)").addEventListener(
  "change",
  updateLibraryToggle,
);
document.addEventListener("click", (e) => {
  if (!e.target.closest(".sidebar") && !e.target.closest(".menu-toggle"))
    document.body.classList.remove("library-open");
  updateLibraryToggle();
});

function playbackLocation(index) {
  if (score?.notes[index]?.type !== "note") return "—";
  const before = score.notes.slice(0, index);
  const line = before.filter((n) => n.type === "break").length + 1;
  const phrase = phraseRange(score.notes, index);
  const note = score.notes
    .slice(phrase.start, index + 1)
    .filter((n) => n.type === "note").length;
  return `${line}句·${note}音`;
}
function updatePlaybackControls() {
  if (!score) return;
  const hasNotes = !original && playback.cursor >= 0;
  $("#playback-cue").textContent = original
    ? "—"
    : playbackLocation(playback.cursor);
  $("#loop-a").textContent =
    "A " +
    (original || playback.a === null ? "—" : playbackLocation(playback.a));
  $("#loop-b").textContent =
    "B " +
    (original || playback.b === null ? "—" : playbackLocation(playback.b));
  for (const id of [
    "set-loop-a",
    "set-loop-b",
    "play-from-start",
    "scope",
    "loop",
  ])
    $("#" + id).disabled = !hasNotes;
  $("#clear-loop-points").disabled =
    !!original || (playback.a === null && playback.b === null);
  $("#loop-selection").disabled = !!original || !selectedNotes().length;
  $('#scope option[value="ab"]').disabled = !!original || !playback.complete;
  $("#scope").value = playback.scope;
  $("#loop").checked = playback.loop;
  $("#loop-phrase").disabled = !hasNotes;
  $("#loop-phrase").setAttribute(
    "aria-pressed",
    String(playback.loop && playback.scope === "phrase"),
  );
  if (!player.playing && !player.paused && audioState !== "loading") {
    const time = timeline(score, 0, Math.max(0, playback.cursor)).duration;
    $("#play-position").textContent =
      `${clock(time)} / ${clock(timeline(score).duration)}`;
  }
}
function seekPlayback(index, { render = true, restart = true } = {}) {
  if (original || !score) return;
  const next = playback.noteAt(score.notes, index);
  if (next < 0) return;
  const running = player.playing || audioState === "loading";
  player.stop();
  playback.cursor = next;
  if (playback.scope === "ab" && (next < playback.a || next > playback.b)) {
    playback.scope = "all";
    playback.loop = false;
    toast("已定位到片段外；A/B 端点仍保留，可重新选择 A–B 片段。");
  }
  updatePlaybackControls();
  if (render) refreshScoreSelection();
  if (running && restart) startPlayback().catch((err) => toast(err.message));
}
async function startPlayback() {
  if (original || !score) return;
  const region = playback.plan(score.notes);
  playbackBaseTime = timeline(score, 0, region.start).duration;
  await player.start(clone(score), {
    ...region,
    voice: prefs.voice,
    loop: playback.loop,
  });
}
function activateLoopRegion() {
  const running = player.playing;
  player.stop();
  playback.scope = "ab";
  playback.loop = true;
  playback.cursor = playback.a;
  renderEditor();
  if (running) startPlayback().catch((err) => toast(err.message));
}
function setLoopMarker(name) {
  try {
    playback.setMarker(name, score.notes);
    if (playback.complete) activateLoopRegion();
    else renderEditor();
  } catch (err) {
    toast(err.message);
  }
}
$("#set-loop-a").onclick = () => setLoopMarker("a");
$("#set-loop-b").onclick = () => setLoopMarker("b");
$("#loop-phrase").onclick = () => {
  if (original) return;
  const active = playback.loop && playback.scope === "phrase";
  player.stop();
  playback.scope = active ? "all" : "phrase";
  playback.loop = !active;
  if (!active) {
    const phrase = playback.region(score.notes);
    playback.cursor = playback.noteAt(score.notes, phrase.start);
  }
  refreshScoreSelection();
  if (!active) startPlayback().catch((err) => toast(err.message));
};
$("#loop-selection").onclick = () => {
  const items = selectedNotes();
  if (!items.length || original) return;
  playback.a = items[0].i;
  playback.b = items.at(-1).i;
  activateLoopRegion();
};
$("#clear-loop-points").onclick = () => {
  player.stop();
  playback.a = playback.b = null;
  if (playback.scope === "ab") {
    playback.scope = "all";
    playback.loop = false;
  }
  renderEditor();
};
$("#play-from-start").onclick = () => {
  playback.scope = "all";
  playback.loop = false;
  playback.cursor = playback.noteAt(score.notes, 0);
  renderEditor();
  startPlayback().catch((err) => toast(err.message));
};
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
    `${clock(playbackBaseTime + time)} / ${clock(timeline(score).duration)}`;
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
      await startPlayback();
    }
  } catch (err) {
    toast(err.message);
  }
}
$("#play").onclick = togglePlay;
$("#stop").onclick = () => {
  player.stop();
  updatePlaybackControls();
};
$("#scope").onchange = (e) => {
  player.stop();
  playback.scope = e.target.value;
  if (playback.scope === "ab") playback.cursor = playback.a;
  renderEditor();
};
$("#loop").onchange = (e) => {
  playback.loop = e.target.checked;
  player.loop = playback.loop;
};
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

function configureSimpleLayout() {
  function menu(id, title, className = "") {
    const details = element("details", `simple-menu ${className}`);
    details.id = id;
    details.append(element("summary", "", title));
    const panel = element("div", "menu-panel");
    details.append(panel);
    details.addEventListener("toggle", () => {
      if (details.open)
        document.querySelectorAll(".simple-menu[open]").forEach((other) => {
          if (other !== details) other.open = false;
        });
    });
    return { details, panel };
  }
  const tools = $(".note-tools"),
    advanced = menu("note-more", "更多", "note-menu");
  const exact = element("details", "exact-tools");
  exact.id = "exact-note-tools";
  exact.append(element("summary", "", "精确设置（可选）"));
  const exactBody = element("div", "exact-body");
  exact.append(exactBody);
  const oldTools = [...tools.childNodes];
  tools.append(advanced.details);
  advanced.panel.append(exact);
  exactBody.append(...oldTools);
  const quick = element("div", "quick-lengths");
  quick.append(element("span", "muted", "一起设为"));
  for (const [title, value] of [
    ["1/8", 0.5],
    ["1/4", 1],
    ["1/2", 2],
    ["全音", 4],
  ]) {
    const b = element("button", "small", title);
    b.dataset.quickLength = value;
    b.onclick = () => {
      const items = selectedRhythmItems();
      if (!items.length || original) return;
      setSelectedDuration(value);
      advanced.details.open = false;
      focusScore();
    };
    quick.append(b);
  }
  const actions = element("div", "more-actions");
  actions.append($("#select-phrase"), $("#duplicate"));
  advanced.panel.append(quick, actions, exact);
  const feel = element("select", "duration-feel");
  feel.id = "duration-feel";
  feel.setAttribute("aria-label", "音长");
  const placeholder = element("option", "", "音长");
  placeholder.value = "";
  placeholder.disabled = true;
  feel.append(placeholder);
  for (const value of [0.25, 0.5, 1, 2, 4]) {
    const option = element(
      "option",
      "",
      value === 0 ? "设为休止" : durationFraction(value),
    );
    option.value = value;
    feel.append(option);
  }
  feel.onchange = (e) => {
    const value = Number(e.target.value),
      items = selectedRhythmItems();
    if (items.length && !original) {
      setSelectedDuration(value);
      focusScore();
    }
  };
  const tail = menu("tail-menu", "延长尾音", "note-menu"),
    pause = menu("pause-menu", "段后留白", "note-menu");
  for (const [m, kind, description, values] of [
    [
      tail,
      "hold",
      "为这段最后一个音增加时长，原音长保留",
      [
        ["＋1/8", 0.5],
        ["＋1/4", 1],
        ["＋1/2", 2],
        ["取消延长", 0],
      ],
    ],
    [
      pause,
      "pause",
      "停一下，再播放后面的数字",
      [
        ["1/4", 1],
        ["1/2", 2],
        ["全音", 4],
        ["去掉留白", 0],
      ],
    ],
  ]) {
    m.panel.append(element("p", "menu-description", description));
    const choices = element("div", "ending-choices");
    for (const [title, value] of values) {
      const b = element("button", "small", title);
      b.dataset[kind] = value;
      b.onclick = () => setPhraseEnding(kind, value);
      choices.append(b);
    }
    m.panel.append(choices);
    m.details.querySelector("summary").onclick = (e) => {
      if (e.currentTarget.getAttribute("aria-disabled") === "true")
        e.preventDefault();
    };
  }
  $("#shorten").textContent = "−";
  $("#lengthen").textContent = "＋";
  tools.append(
    $("#selection-caption"),
    $("#selected-label"),
    $("#shorten"),
    feel,
    $("#lengthen"),
    tail.details,
    pause.details,
    advanced.details,
    $("#undo"),
    $("#redo"),
  );
  exactBody.querySelectorAll(".tool-spacer").forEach((n) => n.remove());
  const footer = $(".transport"),
    settings = menu("playback-settings", "播放设置"),
    practiceMenu = menu("practice-tools", "片段练习");
  const oldFooter = [...footer.childNodes];
  footer.append(settings.details, practiceMenu.details);
  settings.panel.append(...oldFooter);
  const rangeTools = $(".playback-range-controls");
  practiceMenu.panel.append(
    rangeTools,
    $("#scope"),
    $("#loop").closest("label"),
  );
  settings.panel
    .querySelectorAll(".transport-divider")
    .forEach((n) => n.remove());
  $(".duration-scale-control label").textContent = "播放速度";
  footer.append(
    $(".play-controls"),
    $(".duration-scale-control"),
    $("#play-position"),
    $("#loop-phrase"),
    practiceMenu.details,
    settings.details,
  );
  const keyboard = $("#keyboard-help"),
    help = element("details", "writing-help edit-only");
  help.append(element("summary", "", "键盘提示"));
  keyboard.before(help);
  help.append(keyboard);
}
configureSimpleLayout();
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
    const saved = nativeScores.find((s) => s.id === draft.score.id);
    if (saved?.archived === true)
      for (const key of [
        "archived",
        "archivedAt",
        "archiveReason",
        "primaryScoreId",
      ])
        if (saved[key] !== undefined) draft.score[key] = saved[key];
    openScore(draft.score, { restored: true, changed: true });
    toast("已恢复上次未保存的本机草稿。");
  } else if (draft && nativeScores.some((s) => s.id === draft.score.id)) {
    const saved = nativeScores.find((s) => s.id === draft.score.id);
    const primary =
      saved.archived === true &&
      nativeScores.find(
        (s) => s.id === saved.primaryScoreId && s.archived !== true,
      );
    openScore(primary || saved);
  } else if (nativeScores.some((s) => s.archived !== true))
    openScore(nativeScores.find((s) => s.archived !== true));
  else openScore(fresh());
} catch (err) {
  openScore(fresh());
  toast("读取乐谱库失败：" + err.message + "。可以先写谱，连接恢复后再保存。");
}
