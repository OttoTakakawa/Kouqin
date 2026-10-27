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
  phraseRepeat,
  timeline,
} from "./model.mjs";
import { Player } from "./audio.mjs";
import { PlaybackRange } from "./transport.mjs";
import { buildPerformance, PerformanceStage } from "./performance.mjs";
import { PracticeOverview } from "./practice-overview.mjs";

const $ = (s) => document.querySelector(s);
const clone = (value) => structuredClone(value);
const draftKey = "harmonica.draft.v1",
  draftPrefix = "harmonica.draft.v2.",
  lastScoreKey = "harmonica.last-score.v2",
  preferencesKey = "harmonica.preferences.v1";
let draftSession = crypto.randomUUID();
try {
  draftSession = sessionStorage.getItem("harmonica.draft-session.v2") || draftSession;
  sessionStorage.setItem("harmonica.draft-session.v2", draftSession);
} catch {}
let loadedRevision, restoredDraft = null;
const defaults = {
  keys: { ...DEFAULT_KEYS },
  effects: !matchMedia("(prefers-reduced-motion: reduce)").matches,
  voice: "harmonica",
  volume: 55,
  zoom: 100,
  spotlight: 118,
  theme: "ink",
  lyrics: true,
  practiceOverview: false,
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
  tokenSelected = false,
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
let followPlayback = true,
  playbackScrollTop = 0;
const player = new Player();
const playback = new PlaybackRange();
let playbackBaseTime = 0;
let performanceData = null;
let repeatControl = null;
const performanceStage = new PerformanceStage(
  $("#performance-stage"),
  $("#score"),
);
const practiceOverview = new PracticeOverview($("#score"), layout => {
  const status = $("#overview-status");
  status.hidden = !layout;
  status.textContent = layout
    ? layout.columns > 1 ? `${["", "单", "两", "三", "四"][layout.columns]}列 · 先左后右` : "整首 · 一屏"
    : "";
});

function updatePracticeOverview() {
  const enabled = practice && prefs.practiceOverview && !original;
  document.body.classList.toggle("practice-overview", enabled);
  $("#practice-overview").disabled = !!original;
  $("#practice-overview").setAttribute("aria-pressed", String(!!prefs.practiceOverview));
  practiceOverview.setEnabled(enabled);
}

function configurePerformance() {
  // 暂停时关闭舞台是既定行为（performance.spec 有断言）。
  // 暂停后画面不跳变，靠的是 .practice .note.playing 的轻样式，而不是让舞台常驻。
  performanceStage.configure(practice && prefs.effects && !original && player.playing);
}

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
  if (!res.ok) {
    const error = Error(value.error || "操作失败");
    error.status = res.status;
    throw error;
  }
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
  configurePerformance();
  document.body.classList.toggle("lyrics-off", !prefs.lyrics);
  updatePracticeOverview();
  document.body.classList.toggle("sidebar-collapsed", !!prefs.sidebarCollapsed);
  $("#lyrics-toggle")?.setAttribute("aria-pressed", String(!!prefs.lyrics));
  updateLibraryToggle();
  document.documentElement.style.setProperty("--zoom", prefs.zoom / 100);
  document.documentElement.style.setProperty(
    "--spotlight",
    (prefs.spotlight ?? 118) / 100,
  );
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
    ["拖动 / Shift+方向键", "选择"],
    ["Ctrl+A", "全选"],
    ["Ctrl+C / X / V", "复制 / 剪切 / 粘贴"],
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
  if (score && !original && dirty) {
    const key = draftPrefix + score.id + "." + draftSession;
    const value = {
      score: { ...score, revision: loadedRevision },
      dirty,
      cursor,
      selected,
      savedAt: Date.now(),
    };
    let unchanged = false;
    try {
      const previous = JSON.parse(localStorage.getItem(key));
      unchanged = !!previous && JSON.stringify({ ...previous, savedAt: 0 }) ===
        JSON.stringify({ ...value, savedAt: 0 });
    } catch {}
    draftProtected = unchanged || stored(key, value);
    // 先写入新副本，成功后才迁移旧草稿；其他页面的新编辑不能被清除。
    if (draftProtected && restoredDraft?.key === draftKey) {
      try {
        if (localStorage.getItem(restoredDraft.key) === restoredDraft.raw)
          localStorage.removeItem(restoredDraft.key);
        restoredDraft = null;
      } catch {}
    }
  }
}
function readDrafts() {
  const drafts = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key !== draftKey && !key.startsWith(draftPrefix)) continue;
      try {
        const raw = localStorage.getItem(key), value = JSON.parse(raw);
        if (!value?.dirty) continue;
        validateScore(value.score);
        drafts.push({ ...value, key, raw });
      } catch {} // 损坏记录保留原文，不影响其他乐谱恢复。
    }
  } catch {}
  return drafts.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}
function startupDraft(drafts, lastId) {
  const own = drafts.filter((d) => d.key.endsWith("." + draftSession));
  return own.find((d) => d.score.id === lastId) || own[0] ||
    drafts.find((d) => d.score.id === lastId) || drafts[0];
}
function restoreDraft(draft) {
  restoredDraft = draft;
  openScore(draft.score, { restored: true, changed: true });
  saveDraft();
  updateSaveState();
  toast("已恢复这首乐谱未保存的本机草稿。");
}
function openLibraryScore(item) {
  const drafts = readDrafts().filter((draft) => draft.score.id === item.id);
  const own = drafts.find((draft) => draft.key.endsWith("." + draftSession));
  if (own || drafts[0]) restoreDraft(own || drafts[0]);
  else openScore(item);
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
  $("#save-copy").disabled = !!original || saving;
}
function change(mutator, { render = true } = {}) {
  if (original) return;
  const resumeLoop = player.playing && playback.loop;
  player.stop();
  undoStack.push({
    score: playback.copyScore(score),
    cursor,
    selected,
    tokenSelected,
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
  setFollowPlayback(true);
  tokenSelected = false;
  viewEpoch++;
  player.stop();
  original = null;
  activeOriginal = null;
  score = clone(next);
  delete score.kind;
  delete score.unsavedDraft;
  loadedRevision = next.revision;
  if (!restored) restoredDraft = null;
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
  stored(lastScoreKey, score.id);
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
  updatePracticeOverview();
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
// 行级动作统一作用于「光标/选区所在行」。行重复不改音符数量，只给本行音符写 repeat。
function currentPhrase() {
  const at = range ? range.start : selected >= 0 ? selected : cursor;
  const { start, end } = phraseRange(score.notes, at);
  let rowNo = 1;
  for (let i = 0; i < start; i++) if (score.notes[i].type === "break") rowNo++;
  return { start, end, rowNo };
}
function setPhraseRepeat(count) {
  if (original || !score) return;
  const line = currentPhrase();
  if (!score.notes.slice(line.start, line.end).some((n) => n.type === "note")) {
    toast("这一行还没有音符。");
    return;
  }
  const current = phraseRepeat(score.notes, line.start, line.end);
  if (repeatControl) repeatControl.details.open = false;
  if (count === current) {
    updateRepeatControl();
    focusScore();
    return;
  }
  change(() => {
    for (let i = line.start; i < line.end; i++) {
      if (score.notes[i].type !== "note") continue;
      if (count === 1) delete score.notes[i].repeat;
      else score.notes[i].repeat = count;
    }
  });
  toast(
    count === 1
      ? `第 ${line.rowNo} 行已取消重复，请保存乐谱。`
      : `第 ${line.rowNo} 行共播放 ${count} 遍，请保存乐谱。`,
  );
  focusScore();
}
function updateRepeatControl() {
  const control = repeatControl;
  if (!control || !score) return;
  const line = currentPhrase();
  const hasNotes = score.notes
    .slice(line.start, line.end)
    .some((n) => n.type === "note");
  const count = hasNotes
    ? phraseRepeat(score.notes, line.start, line.end)
    : 1;
  control.summary.textContent = count > 1 ? `重复 ×${count}` : "重复";
  control.details.classList.toggle("has-value", count > 1);
  const disabled = !!original || !hasNotes;
  control.summary.setAttribute("aria-disabled", String(disabled));
  control.description.textContent = original
    ? "原有收藏只读，不能设置行重复。"
    : !hasNotes
      ? "这一行还没有音符。"
      : `第 ${line.rowNo} 行 · 整行共播放 ${count} 遍`;
  for (const button of control.choices.querySelectorAll("[data-repeat]")) {
    const value = Number(button.dataset.repeat);
    button.disabled = disabled;
    button.classList.toggle("selected", value === count);
    button.setAttribute("aria-pressed", String(value === count));
  }
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
  performanceStage.reset();
  performanceData = buildPerformance(score);
  passLyricCache = { index: -1, row: null };
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
    const repeatCount = phraseRepeat(score.notes, line.start, line.end);
    const repeatMarker =
      repeatCount > 1
        ? element("span", "row-repeat-mark", `×${repeatCount}`)
        : null;
    if (repeatMarker) {
      repeatMarker.setAttribute("aria-label", `本行共播放 ${repeatCount} 遍`);
      repeatMarker.title = `整行共播放 ${repeatCount} 遍（含第一次）`;
    }
    const lineEnd = element("button", "line-end edit-only", "行尾");
    lineEnd.type = "button";
    lineEnd.tabIndex = -1;
    lineEnd.setAttribute("aria-label", `定位第 ${lineNo + 1} 行末尾`);
    lineEnd.title = "点击后可在本行末尾输入或粘贴；点击行号选择整行";
    if (practice) {
      if (repeatMarker) row.append(repeatMarker);
    } else {
      // 行级动作收到右侧固定竖列：只出现当前行，标记常驻。
      const actions = element("div", "row-actions");
      if (repeatMarker) actions.append(repeatMarker);
      actions.append(lineEnd);
      row.append(actions);
    }
    const lyricText = score.lyrics?.[lineNo];
    if (lyricText) {
      const lyric = element("span", "lyric");
      // 整行重复时，歌词可以按遍分行；两层交错淡入淡出，避免换字像硬切。
      lyric.dataset.full = lyricText;
      const current = element("span", "lyric-layer active");
      current.textContent = lyricText;
      const incoming = element("span", "lyric-layer");
      incoming.setAttribute("aria-hidden", "true");
      lyric.append(current, incoming);
      row.append(lyric);
    }
    root.append(row);
  }
  root.scrollTop = scroll;
  if (playingIndex >= 0 && (player.playing || player.paused))
    root
      .querySelector(`[data-index="${playingIndex}"]`)
      ?.classList.add("playing");
  $("#note-count").textContent =
    `${score.notes.filter((n) => n.type === "note").length} 个音符 · ${lines.length} 句`;
  document.body.classList.toggle(
    "show-lyrics",
    Array.isArray(score.lyrics) && score.lyrics.some((t) => t && t.trim()),
  );
  updateDuration();
  updateRepeatControl();
  updatePracticeOverview();
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
    else {
      const lastRow = [...root.querySelectorAll(".phrase")].find(
        (row) => Number(row.dataset.end) === cursor,
      );
      if (lastRow)
        (lastRow.querySelector(".row-actions") ?? lastRow).before(caret);
    }
  }
  updateDuration();
  updateRepeatControl();
}
$("#score").addEventListener("click", (e) => {
  tokenSelected = false;
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
    if (
      firstNote >= 0 &&
      (practice ||
        followPlayback ||
        (!player.playing && audioState !== "loading") ||
        replay)
    )
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
    selected = e.shiftKey && selected >= 0 ? selected : index;
    cursor = range ? (index === range.start ? range.start : range.end) : index;
    tokenSelected = !e.shiftKey;
    if (
      !e.shiftKey &&
      (followPlayback || (!player.playing && audioState !== "loading"))
    )
      seekPlayback(index, { render: false });
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
  if (target && !e.shiftKey) {
    seekPlayback(Number(target.dataset.index), {
      render: false,
      restart: false,
    });
    startPlayback().catch((err) => toast(err.message));
  }
});
function insert(notes, { replaceSelection = true } = {}) {
  const start = range ? (replaceSelection ? range.start : range.end) : cursor,
    count = range && replaceSelection ? range.end - range.start : 0;
  if (score.notes.length - count + notes.length > 20000)
    return toast("每首最多 20,000 个音符和分隔符。");
  change(() => {
    score.notes.splice(start, count, ...notes);
    tokenSelected = false;
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
    tokenSelected,
    range: clone(range),
  });
  const snapshot = from.pop();
  const previousNotes = score.notes;
  ({ score, cursor, selected, tokenSelected, range } = snapshot);
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
  if (e.target.closest("select")) return;
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
    const anchor = range
      ? cursor === range.start
        ? range.end
        : range.start
      : cursor;
    tokenSelected = false;
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
    range =
      e.shiftKey && cursor !== anchor
        ? { start: Math.min(anchor, cursor), end: Math.max(anchor, cursor) }
        : null;
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
    let start =
        range?.start ??
        (tokenSelected
          ? selected
          : e.key === "Backspace"
            ? cursor - 1
            : cursor),
      count = range ? range.end - range.start : 1;
    if (start < 0 || start >= score.notes.length) return;
    change(() => {
      score.notes.splice(start, count);
      tokenSelected = false;
      cursor = start;
      selected = score.notes[start]?.type === "note" ? start : -1;
      range = null;
    });
  }
});
const clipboardType = "application/x-harmonica-notes";
let copiedNotes = null;
function copySelection() {
  return clone(
    range
      ? score.notes.slice(range.start, range.end)
      : selected >= 0
        ? [score.notes[selected]]
        : [],
  );
}
function rememberCopy(notes) {
  copiedNotes = { text: serializeNotation(notes), notes: clone(notes) };
  return copiedNotes.text;
}
function removeCopiedSelection() {
  const start = range?.start ?? selected,
    count = range ? range.end - range.start : 1;
  if (start < 0 || !count) return;
  change(() => {
    score.notes.splice(start, count);
    cursor = start;
    selected = -1;
    tokenSelected = false;
    range = null;
  });
  focusScore();
}
function pasteNotes(data, text) {
  if (practice || original) return;
  const notes = data
    ? JSON.parse(data)
    : copiedNotes && copiedNotes.text === text
      ? clone(copiedNotes.notes)
      : parseNotation(text);
  validateScore({ ...score, notes });
  if (!notes.length) return toast("剪贴板中没有可粘贴的音符。");
  insert(notes);
}
function copyEvent(e, cut = false) {
  if (cut && (practice || original)) return;
  const notes = copySelection();
  if (!notes.length) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", rememberCopy(notes));
  e.clipboardData.setData(clipboardType, JSON.stringify(notes));
  if (cut) removeCopiedSelection();
}
$("#score").addEventListener("copy", (e) => copyEvent(e));
$("#score").addEventListener("cut", (e) => copyEvent(e, true));
$("#score").addEventListener("paste", (e) => {
  if (practice || original) return;
  e.preventDefault();
  try {
    pasteNotes(
      e.clipboardData.getData(clipboardType),
      e.clipboardData.getData("text/plain"),
    );
  } catch (err) {
    toast(err.message);
  }
});

function clipboardPosition() {
  return JSON.stringify({
    viewEpoch,
    version,
    cursor,
    selected,
    range,
    practice,
    original: !!original,
  });
}
async function writeClipboardNotes(notes) {
  const text = serializeNotation(notes),
    richType = `web ${clipboardType}`;
  if (globalThis.ClipboardItem?.supports?.(richType)) {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        [richType]: new Blob([JSON.stringify(notes)], { type: clipboardType }),
      }),
    ]);
  } else await navigator.clipboard.writeText(text);
  rememberCopy(notes);
}
async function readClipboardNotes() {
  if (!navigator.clipboard.read)
    return { text: await navigator.clipboard.readText(), data: "" };
  const items = await navigator.clipboard.read(),
    richType = `web ${clipboardType}`;
  for (const item of items) {
    if (item.types.includes(richType))
      return { data: await (await item.getType(richType)).text(), text: "" };
  }
  for (const item of items) {
    if (item.types.includes("text/plain"))
      return {
        text: await (await item.getType("text/plain")).text(),
        data: "",
      };
  }
  return { text: "", data: "" };
}
async function clipboardAction(action) {
  if (practice || original) return;
  focusScore();
  const position = clipboardPosition();
  try {
    if (action === "paste") {
      const { data, text } = await readClipboardNotes();
      if (position !== clipboardPosition())
        return toast("粘贴位置已改变，请在目标位置重新粘贴。");
      pasteNotes(data, text);
    } else {
      const notes = copySelection();
      if (!notes.length) return toast("请先选择要复制的音符。");
      await writeClipboardNotes(notes);
      if (action === "cut") {
        if (position !== clipboardPosition())
          return toast("已复制；选区已改变，未删除原音符。");
        removeCopiedSelection();
      }
      toast(
        action === "cut"
          ? "已剪切，可在目标位置粘贴。"
          : "已复制，保留音长与换行。",
      );
    }
  } catch (err) {
    const key = { copy: "C", cut: "X", paste: "V" }[action];
    toast(
      err.name === "NotAllowedError" || err instanceof TypeError
        ? `无法访问剪贴板，请点击谱面后按 Ctrl+${key}。`
        : err.message,
    );
  }
}

// 空白、音符间隙和换行都按最近音符定位，不能落回浏览器的文字选区。
let dragSelection = null,
  suppressScoreClick = false;
function nearestScoreToken(x, y, root = $("#score")) {
  let nearest = null, distance = Infinity;
  for (const token of root.querySelectorAll("[data-index]")) {
    const box = token.getBoundingClientRect();
    const dx = Math.max(box.left - x, 0, x - box.right);
    const dy = Math.max(box.top - y, 0, y - box.bottom);
    const next = dx * dx + dy * dy;
    if (next < distance) {
      nearest = token;
      distance = next;
    }
  }
  return nearest;
}
$("#score").addEventListener("pointerdown", (e) => {
  const row = e.target.closest(".phrase");
  if (
    practice ||
    original ||
    e.button !== 0 ||
    e.target.closest(".line-number") ||
    e.target.closest(".row-actions") ||
    e.pointerType === "touch"
  )
    return;
  const token = e.target.closest("[data-index]") ||
    nearestScoreToken(e.clientX, e.clientY, row || $("#score"));
  if (!token) return;
  e.preventDefault();
  window.getSelection()?.removeAllRanges();
  focusScore();
  suppressScoreClick = false;
  dragSelection = {
    index: Number(token.dataset.index),
    pointerId: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    moved: false,
  };
});
document.addEventListener("pointermove", (e) => {
  if (!dragSelection || e.pointerId !== dragSelection.pointerId || !(e.buttons & 1)) return;
  if (
    !dragSelection.moved &&
    Math.hypot(e.clientX - dragSelection.x, e.clientY - dragSelection.y) < 5
  )
    return;
  const token = document
    .elementFromPoint(e.clientX, e.clientY)
    ?.closest("#score [data-index]") || nearestScoreToken(e.clientX, e.clientY);
  if (!token) return;
  if (!dragSelection.moved) $("#score").setPointerCapture(e.pointerId);
  e.preventDefault();
  dragSelection.moved = true;
  const index = Number(token.dataset.index);
  range = {
    start: Math.min(dragSelection.index, index),
    end: Math.max(dragSelection.index, index) + 1,
  };
  selected = dragSelection.index;
  cursor = index < dragSelection.index ? range.start : range.end;
  tokenSelected = false;
  window.getSelection()?.removeAllRanges();
  refreshScoreSelection();
});
document.addEventListener("pointerup", () => {
  if (dragSelection?.moved) {
    suppressScoreClick = true;
    focusScore();
  }
  dragSelection = null;
});
document.addEventListener("pointercancel", () => {
  dragSelection = null;
});
$("#score").addEventListener(
  "click",
  (e) => {
    if (!suppressScoreClick) return;
    suppressScoreClick = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  },
  true,
);

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
  const pending = new Map();
  for (const draft of readDrafts())
    if (!nativeScores.some((s) => s.id === draft.score.id) && !pending.has(draft.score.id))
      pending.set(draft.score.id, { ...draft.score, kind: "native", unsavedDraft: true });
  const all = [
    ...nativeScores.map((s) => ({ ...s, kind: "native" })),
    ...pending.values(),
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
            : (item.unsavedDraft ? "未保存草稿" : item.archived === true ? "归档版本" : item.status || "未练习") +
                " · " +
                item.key +
                " 调",
        ),
      );
      button.onclick = () => {
        if (!rememberLeave()) return;
        if (item.kind === "original") loadOriginal(item);
        else openLibraryScore(item);
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
let saveReview = null;
function describeScoreForSave(value) {
  const lines = [];
  let current = [], repeat = 1;
  for (const note of value.notes) {
    if (note.type === "break") {
      lines.push(current.join(" ") + (repeat > 1 ? `　×${repeat}` : ""));
      current = []; repeat = 1;
    } else {
      repeat = Math.max(repeat, note.repeat || 1);
      current.push(note.type === "space" ? "·" : `${note.degree === 0 ? "停" : label(note)}（${note.duration}拍${note.tailHold ? `＋尾音${note.tailHold}拍` : ""}）`);
    }
  }
  lines.push(current.join(" ") + (repeat > 1 ? `　×${repeat}` : ""));
  return `${value.title}\n${value.key}调 · ${value.bpm} BPM${value.durationScale ? ` · 音长倍率 ${value.durationScale}` : ""}\n分类：${value.category || "未分类"} · ${value.status || "未练习"}${value.favorite ? " · 已收藏" : ""}${value.archived ? " · 已归档" : ""}\n保存时间：${value.updatedAt ? new Date(value.updatedAt).toLocaleString() : "未记录"}\n\n` +
    Array.from({ length: Math.max(lines.length, value.lyrics?.length || 0) }, (_, i) =>
      `${String(i + 1).padStart(2, "0")}　${lines[i] ?? "（无对应谱句）"}\n歌词：${value.lyrics?.[i] || "（留空）"}`).join("\n\n");
}
function reviewLegacySave(disk, snapshot, currentVersion) {
  saveReview = { disk, id: snapshot.id, version: currentVersion };
  $("#save-review-disk").textContent = describeScoreForSave(disk);
  $("#save-review-current").textContent = describeScoreForSave(snapshot);
  $("#save-review-error").textContent = "";
  $("#message").textContent = "旧草稿缺少保存版本，请核对后保存到原谱，或另存副本。";
  $("#save-review-dialog").showModal();
}
async function save({ confirmedRevision, expectedVersion } = {}) {
  if (original) return;
  if ($("#save-review-dialog").open && !confirmedRevision) return;
  if (saving) {
    requestSaveAgain = true;
    return;
  }
  if (!score.title.trim()) {
    score.title = "未命名乐谱";
    $("#title").value = score.title;
  }
  const snapshot = { ...clone(score), revision: confirmedRevision || loadedRevision },
    id = score.id,
    currentVersion = version;
  let legacyDisk = null;
  try {
    validateScore(snapshot);
    if (expectedVersion !== undefined && expectedVersion !== currentVersion)
      throw Error("当前编辑已变化，请取消后重新点击保存核对。");
    saving = true;
    updateSaveState();
    if (!snapshot.revision) {
      const disk = (await api("/api/scores")).find(s => s.id === id);
      if (disk) {
        if (!disk.revision) throw Error("当前服务尚未提供版本保护，请更新服务后再保存；当前草稿仍保留。");
        if (score.id !== id || version !== currentVersion) return null;
        legacyDisk = disk;
      }
      if (!disk && (nativeScores.some(s => s.id === id) || snapshot.updatedAt))
        throw Error("原曲库已没有这首乐谱，请另存副本以保留当前编辑。");
    }
    const result = await api("/api/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    });
    if (!result.revision)
      throw Error("当前服务尚未提供版本保护，请先导出当前编辑，并在更新服务后再保存。");
    snapshot.updatedAt = result.updatedAt;
    snapshot.revision = result.revision;
    nativeScores = [snapshot, ...nativeScores.filter((s) => s.id !== id)];
    if (!original && score.id === id) {
      score.updatedAt = result.updatedAt;
      score.revision = loadedRevision = result.revision;
      if (currentVersion === version) {
        dirty = false;
        try {
          localStorage.removeItem(draftPrefix + id + "." + draftSession);
        } catch {}
      }
      saveDraft();
      $("#message").textContent =
        "已保存 " + new Date(result.updatedAt).toLocaleTimeString();
    }
    renderLibrary();
    return result;
  } catch (err) {
    if (err.status === 428 && legacyDisk && !snapshot.revision &&
        !original && score.id === id && version === currentVersion) {
      reviewLegacySave(legacyDisk, snapshot, currentVersion);
      return null;
    }
    $("#message").textContent = "保存失败：" + err.message;
    toast("保存失败：" + err.message);
    return null;
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
$("#save-review-confirm").onclick = async () => {
  if (saving || !saveReview) return;
  if (original || score.id !== saveReview.id || version !== saveReview.version) {
    $("#save-review-error").textContent = "当前编辑已变化，请取消后重新点击保存核对。";
    return;
  }
  $("#save-review-confirm").disabled = true;
  $("#save-review-copy").disabled = true;
  const result = await save({ confirmedRevision: saveReview.disk.revision, expectedVersion: saveReview.version });
  $("#save-review-confirm").disabled = false;
  $("#save-review-copy").disabled = false;
  if (result) $("#save-review-dialog").close();
  else $("#save-review-error").textContent = $("#message").textContent + " 请取消后重新核对；当前编辑仍保留。";
};
$("#save-review-copy").onclick = () => {
  $("#save-review-dialog").close();
  $("#save-copy").click();
};
$("#save-copy").onclick = async () => {
  if (original || saving) return;
  saveDraft();
  const sourceKey = draftPrefix + score.id + "." + draftSession;
  let sourceRaw;
  try { sourceRaw = localStorage.getItem(sourceKey); } catch {}
  const copy = { ...clone(score), id: crypto.randomUUID(), title: score.title + "（副本）" };
  // 来源的版本和时间不属于新谱。失败时保留来源与副本两份草稿。
  delete copy.revision;
  delete copy.updatedAt;
  if (copy.title.length > 200) copy.title = copy.title.slice(0, 196) + "（副本）";
  openScore(copy, { changed: true });
  const result = await save();
  if (result && score.id === copy.id && !dirty) {
    try {
      if (sourceRaw && localStorage.getItem(sourceKey) === sourceRaw)
        localStorage.removeItem(sourceKey);
    } catch {}
    toast("已另存副本，原乐谱未覆盖。");
  }
};
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
    try {
      localStorage.removeItem(draftPrefix + score.id + "." + draftSession);
    } catch {}
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
    delete next.revision; // 导入始终创建新 ID，不能沿用来源的保存版本。
    delete next.updatedAt;
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
  $("#spotlight").value = prefs.spotlight ?? 118;
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
  prefs.spotlight = Number($("#spotlight").value);
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
  configurePerformance();
  updatePlaybackScrollSpace();
}
$("#edit-mode").onclick = () => setMode(false);
$("#practice-mode").onclick = () => setMode(true);
$("#practice-overview").onclick = () => {
  prefs.practiceOverview = !prefs.practiceOverview;
  persistPreferences();
  updatePracticeOverview();
};
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
  performanceData = buildPerformance(score);
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

/* ---------- 歌词：手动录一句一行，练习模式可选显示 ---------- */
let passLyricCache = { index: -1, row: null };
function setLyricText(lyric, text) {
  const layers = [...lyric.querySelectorAll(".lyric-layer")];
  if (!layers.length) {
    if (lyric.textContent !== text) lyric.textContent = text;
    return;
  }
  let active = layers.find((layer) => layer.classList.contains("active"));
  if (!active) active = layers[0];
  if (active.textContent === text) return;
  const incoming = layers.find((layer) => layer !== active);
  if (!incoming) {
    active.textContent = text;
    return;
  }
  incoming.textContent = text;
  incoming.removeAttribute("aria-hidden");
  incoming.classList.remove("inactive");
  // 先落一帧，保证 0 → 1 的透明度与位移过渡真的会跑。
  void incoming.offsetWidth;
  incoming.classList.add("active");
  active.classList.remove("active");
  active.classList.add("inactive");
  active.setAttribute("aria-hidden", "true");
}
function resetPassLyrics() {
  document.querySelectorAll(".lyric").forEach((lyric) => {
    const full = lyric.dataset.full ?? "";
    const layers = [...lyric.querySelectorAll(".lyric-layer")];
    if (!layers.length) {
      if (lyric.textContent !== full) lyric.textContent = full;
    } else {
      layers[0].textContent = full;
      layers[0].classList.add("active");
      layers[0].classList.remove("inactive");
      layers[0].removeAttribute("aria-hidden");
      layers.slice(1).forEach((layer) => {
        layer.textContent = "";
        layer.classList.remove("active");
        layer.classList.add("inactive");
        layer.setAttribute("aria-hidden", "true");
      });
    }
    delete lyric.dataset.pass;
  });
  passLyricCache = { index: -1, row: null };
}
// 整行重复时，一句歌词可按遍写多行；播放到第几遍就显示第几行。
// 只写一行则每遍都用这一句，不改变旧谱歌词的含义。
function updatePassLyric(index, time) {
  if (!practice || index < 0 || !score) return;
  const row =
    passLyricCache.index === index && passLyricCache.row?.isConnected
      ? passLyricCache.row
      : $(`.note[data-index="${index}"]`)?.closest(".phrase");
  if (!row) return;
  passLyricCache = { index, row };
  const lyric = row.querySelector(".lyric");
  if (!lyric) return;
  const full = lyric.dataset.full ?? "";
  const lines = full
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length <= 1) return;
  const count = phraseRepeat(
    score.notes,
    Number(row.dataset.start),
    Number(row.dataset.end),
  );
  if (count <= 1) {
    if (lyric.dataset.pass !== undefined) {
      setLyricText(lyric, full);
      delete lyric.dataset.pass;
    }
    return;
  }
  let pass = 0;
  for (const event of player.sequence?.events ?? []) {
    if (event.index !== index) continue;
    if (event.at > time + 0.001) break;
    pass++;
  }
  const line = pass <= 1 ? lines[0] : (lines[pass - 1] ?? "");
  if (lyric.dataset.pass !== String(pass)) {
    lyric.dataset.pass = String(pass);
    setLyricText(lyric, line);
  }
}
function lyricLines() {
  const lines = [];
  let start = 0;
  for (let i = 0; i <= score.notes.length; i++)
    if (i === score.notes.length || score.notes[i].type === "break") {
      lines.push({ start, end: i });
      start = i + 1;
    }
  return lines;
}
function renderLyricsEditor() {
  const root = $("#lyrics-list");
  root.replaceChildren();
  const lines = lyricLines();
  const currentStart = phraseRange(score.notes, selected >= 0 ? selected : cursor).start;
  for (let index = 0; index < Math.max(lines.length, score.lyrics?.length || 0); index++) {
    const line = lines[index];
    const row = element("label", "lyrics-row" + (line?.start === currentStart ? " current-lyric" : ""));
    const preview = element("span", "lyrics-score");
    const notation = element("span", "lyrics-notation");
    notation.setAttribute("aria-label", `第 ${index + 1} 句数字谱`);
    const notes = line ? score.notes.slice(line.start, line.end) : [];
    for (const n of notes) {
      const token = element("span", "lyrics-note" + (n.type === "space" || n.degree === 0 ? " muted" : ""),
        n.type === "space" ? "·" : n.degree === 0 ? "停" : label(n));
      if (n.type === "note") {
        token.style.fontSize = `${Math.min(28, Math.max(16, 22 + 5 * Math.log2(n.duration)))}px`;
        token.title = `${durationFraction(n.duration)}，${n.duration}拍${n.tailHold ? `，尾音延长${n.tailHold}拍` : ""}`;
      }
      notation.append(token);
    }
    if (!notes.length) notation.append(element("span", "lyrics-empty", line ? "空白谱句" : "暂无对应谱句 · 原歌词保留"));
    const repeatCount = line
      ? phraseRepeat(score.notes, line.start, line.end)
      : 1;
    if (repeatCount > 1)
      notation.append(element("span", "lyrics-repeat", `×${repeatCount}`));
    preview.append(element("span", "line-index", String(index + 1).padStart(2, "0")), notation);
    const input = element("textarea");
    input.rows = 2;
    input.maxLength = 300;
    input.value = score.lyrics?.[index] ?? "";
    input.placeholder =
      repeatCount > 1
        ? `整行重复 ×${repeatCount}：每行写一遍；只写一行则每遍相同，少写的遍数留空`
        : "这一句的歌词，可留空";
    input.title =
      repeatCount > 1
        ? "整行重复时，一行歌词对应一遍；少写的遍数不显示"
        : "练习模式会在这一句右侧显示";
    input.setAttribute("aria-label", `第 ${index + 1} 句歌词`);
    input.addEventListener("input", () => fitLyricText(input));
    row.append(preview, input);
    root.append(row);
  }
}
function fitLyricText(input) {
  input.style.height = "auto";
  input.style.height = `${Math.max(64, input.scrollHeight + 2)}px`;
}
function fitLyricsEditor() {
  if ($("#lyrics-dialog").open)
    $("#lyrics-list").querySelectorAll("textarea").forEach(fitLyricText);
}
window.addEventListener("resize", fitLyricsEditor);
$("#lyrics-toggle").onclick = () => {
  prefs.lyrics = !prefs.lyrics;
  persistPreferences();
  applyPreferences();
  toast(prefs.lyrics ? "歌词已显示。" : "歌词已隐藏。");
};
$("#lyrics-open").onclick = () => {
  if (original) return;
  renderLyricsEditor();
  $("#lyrics-dialog").showModal();
  fitLyricsEditor();
  const active = $("#lyrics-list .current-lyric");
  active?.scrollIntoView({ block: "nearest" });
  active?.querySelector("textarea").focus({ preventScroll: true });
};
$("#lyrics-form").onsubmit = (event) => {
  event.preventDefault();
  if (original) return;
  const next = [...$("#lyrics-list").querySelectorAll("textarea")].map((input) =>
    input.value.trim(),
  );
  $("#lyrics-dialog").close();
  const current = Array.isArray(score.lyrics) ? score.lyrics : [];
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  change(() => {
    if (next.some(Boolean)) score.lyrics = next;
    else delete score.lyrics;
  });
  toast(next.some(Boolean) ? "歌词已应用，请保存乐谱。" : "歌词已清空，请保存乐谱。");
};

/* Annotations live on notes, so inserting, splitting, copying and undoing keep them attached. */
$("#performance-open").onclick = () => {
  if (original) return;
  const root = $("#performance-list");
  root.replaceChildren();
  lyricLines().forEach((line, index) => {
    const notes = score.notes
      .slice(line.start, line.end)
      .filter((note) => note.type === "note");
    if (!notes.length) return;
    const row = element("label", "performance-row");
    const preview = element(
      "span",
      "performance-preview",
      `${String(index + 1).padStart(2, "0")}　${serializeNotation(notes)}`,
    );
    preview.title = preview.textContent;
    const select = element("select");
    select.setAttribute("aria-label", `第 ${index + 1} 句演出`);
    select.dataset.start = line.start;
    select.dataset.end = line.end;
    for (const [value, label] of [
      ["", "自动"],
      ["chorus", "副歌 · 更强"],
      ["calm", "平缓 · 收敛"],
    ]) {
      const option = element("option", "", label);
      option.value = value;
      select.append(option);
    }
    const modes = new Set(notes.map((note) => note.performance || ""));
    if (modes.size > 1) {
      const option = element("option", "", "混合 · 保留");
      option.value = "mixed";
      select.append(option);
    }
    select.value = modes.size === 1 ? [...modes][0] : "mixed";
    row.append(preview, select);
    root.append(row);
  });
  $("#performance-dialog").showModal();
};
$("#performance-form").onsubmit = (event) => {
  event.preventDefault();
  if (original) return;
  const selections = [...$("#performance-list").querySelectorAll("select")];
  const updates = [];
  for (const select of selections) {
    if (select.value === "mixed") continue;
    for (
      let i = Number(select.dataset.start);
      i < Number(select.dataset.end);
      i++
    ) {
      const note = score.notes[i];
      if (note.type === "note" && (note.performance || "") !== select.value)
        updates.push({ note, value: select.value });
    }
  }
  $("#performance-dialog").close();
  if (!updates.length) return;
  change(() => {
    for (const { note, value } of updates) {
      if (value) note.performance = value;
      else delete note.performance;
    }
  });
  toast("段落演出已应用，播放练习时查看；保存乐谱后会一起保留。");
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
function setFollowPlayback(value) {
  followPlayback = value;
  const button = $("#follow-playback");
  if (!button) return;
  button.textContent = value ? "跟随播放" : "回到播放行";
  button.setAttribute("aria-pressed", String(value));
}
function updatePlaybackScrollSpace() {
  const root = $("#score"),
    active = !practice && ["loading", "playing", "paused"].includes(audioState),
    before = parseFloat(getComputedStyle(root, "::before").height) || 0,
    scroll = root.scrollTop;
  root.style.setProperty("--score-viewport", `${root.clientHeight}px`);
  root.classList.toggle("playback-scrolling", active);
  const after = parseFloat(getComputedStyle(root, "::before").height) || 0;
  root.scrollTop = scroll + after - before;
  playbackScrollTop = root.scrollTop;
}
function centerPlaybackRow() {
  if (practice || !followPlayback || playingIndex < 0) return;
  const root = $("#score"),
    row = root
      .querySelector(`.note[data-index="${playingIndex}"]`)
      ?.closest(".phrase");
  if (!row) return;
  const viewport = root.getBoundingClientRect(),
    bounds = row.getBoundingClientRect();
  root.scrollTop +=
    bounds.top -
    viewport.top -
    root.clientTop +
    (bounds.height - root.clientHeight) / 2;
  playbackScrollTop = root.scrollTop;
}
const scoreViewport = $("#score");
function suspendPlaybackFollow() {
  if (!practice && ["playing", "loading", "paused"].includes(audioState))
    setFollowPlayback(false);
}
scoreViewport.addEventListener("wheel", suspendPlaybackFollow, {
  passive: true,
});
scoreViewport.addEventListener("touchstart", suspendPlaybackFollow, {
  passive: true,
});
scoreViewport.addEventListener("pointerdown", (e) => {
  if (e.target === scoreViewport) suspendPlaybackFollow();
});
scoreViewport.addEventListener(
  "scroll",
  () => {
    if (Math.abs(scoreViewport.scrollTop - playbackScrollTop) > 2)
      suspendPlaybackFollow();
  },
  { passive: true },
);
new ResizeObserver(() => {
  updatePlaybackScrollSpace();
  if (player.playing) centerPlaybackRow();
}).observe(scoreViewport);
player.onState = (state) => {
  audioState = state;
  configurePerformance();
  if (state !== "playing") performanceStage.reset();
  // 停止或换音色后，上一个音的高亮必须当场消失；
  // 只靠 onFrame(-1) 清会有先后顺序的漏洞，圈会死停在某一格。
  if (state === "stopped" || state === "loading") {
    document
      .querySelectorAll(".note.playing")
      .forEach((n) => n.classList.remove("playing"));
    playingIndex = -1;
    resetPassLyrics();
  }
  updatePlaybackScrollSpace();
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
    `${clock(playbackBaseTime + time)} / ${clock(performanceData?.duration ?? duration)}`;
  updatePassLyric(index, time);
  if (performanceStage.enabled && performanceData) {
    const node =
      performanceStage.node?.isConnected &&
      Number(performanceStage.node.dataset.index) === index
        ? performanceStage.node
        : $(`.note[data-index="${index}"]`);
    const audioTime = Math.max(
      player.offset,
      player.context.currentTime - player.epoch + player.offset,
    );
    const activeEvent = player.sequence?.events.find(
      event => event.at <= audioTime && event.at + event.duration > audioTime,
    );
    const expression = performanceData.byIndex.get(index);
    performanceStage.frame(
      playbackBaseTime + audioTime,
      activeEvent && expression
        ? { ...expression, at: playbackBaseTime + activeEvent.at, duration: activeEvent.duration }
        : expression,
      node,
      performanceData.beatSeconds,
    );
  }
  if (playingIndex === index) return;
  document
    .querySelectorAll(".note.playing")
    .forEach((n) => n.classList.remove("playing"));
  playingIndex = index;
  if (index >= 0) {
    const node = $(`.note[data-index="${index}"]`);
    node?.classList.add("playing");
    // 当前句跟着播放走，练习模式才知道「现在读到哪」
    const row = node?.closest(".phrase");
    if (row && !row.classList.contains("current")) {
      document
        .querySelectorAll(".phrase.current")
        .forEach((r) => r.classList.remove("current"));
      row.classList.add("current");
    }
    if (practice && !prefs.practiceOverview)
      node?.scrollIntoView({ block: "nearest", behavior: "auto" });
    else centerPlaybackRow();
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
  const newline = element("button", "pill", "换行");
  newline.id = "insert-newline";
  newline.type = "button";
  newline.title = "在光标处换行，也可按 Enter（可在设置中更改）";
  newline.onclick = () => insert([{ type: "break" }]);
  const clipboardTools = element("div", "clipboard-tools");
  clipboardTools.setAttribute("role", "group");
  clipboardTools.setAttribute("aria-label", "剪贴板操作");
  for (const [action, title, key] of [
    ["copy", "复制", "C"],
    ["cut", "剪切", "X"],
    ["paste", "粘贴", "V"],
  ]) {
    const button = element("button", "small", title);
    button.id = `${action}-notes`;
    button.type = "button";
    button.title = `${title} Ctrl+${key}`;
    button.onclick = () => clipboardAction(action);
    clipboardTools.append(button);
  }
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
  const repeat = menu("repeat-menu", "重复", "note-menu");
  const repeatDescription = element(
    "p",
    "menu-description",
    "整行总共播放几遍（含第一次），先点一个音或行号选本行。",
  );
  const repeatChoices = element("div", "ending-choices repeat-choices");
  for (let count = 1; count <= 8; count++) {
    const b = element("button", "small", count === 1 ? "不重复" : `×${count}`);
    b.dataset.repeat = count;
    b.setAttribute("aria-pressed", "false");
    b.onclick = () => setPhraseRepeat(count);
    repeatChoices.append(b);
  }
  repeat.panel.append(repeatDescription, repeatChoices);
  const repeatSummary = repeat.details.querySelector("summary");
  repeatControl = {
    ...repeat,
    summary: repeatSummary,
    description: repeatDescription,
    choices: repeatChoices,
  };
  repeat.details.addEventListener("toggle", () => {
    if (repeat.details.open) updateRepeatControl();
  });
  repeatSummary.onclick = (e) => {
    if (e.currentTarget.getAttribute("aria-disabled") === "true")
      e.preventDefault();
  };
  $("#shorten").textContent = "−";
  $("#lengthen").textContent = "＋";
  const durationStepper = element("div", "duration-stepper");
  durationStepper.append($("#shorten"), feel, $("#lengthen"));
  tools.append(
    $("#selection-caption"),
    $("#selected-label"),
    durationStepper,
    tail.details,
    pause.details,
    repeat.details,
    advanced.details,
    $("#undo"),
    $("#redo"),
    clipboardTools,
    newline,
  );
  exactBody.querySelectorAll(".tool-spacer").forEach((n) => n.remove());
  const footer = $(".transport"),
    practiceMenu = menu("practice-tools", "片段练习");
  const follow = element("button", "text-button edit-only", "跟随播放");
  follow.id = "follow-playback";
  follow.type = "button";
  follow.setAttribute("aria-pressed", "true");
  follow.title = "手动滚动后暂停跟随；点击回到播放行并恢复居中";
  follow.onclick = () => {
    setFollowPlayback(!followPlayback);
    centerPlaybackRow();
  };
  const rangeTools = $(".playback-range-controls");
  practiceMenu.panel.append(
    rangeTools,
    $("#scope"),
    $("#loop").closest("label"),
  );
  footer.querySelectorAll(".transport-divider").forEach((n) => n.remove());
  $(".duration-scale-control label").textContent = "播放速度";
  footer.append(
    $(".play-controls"),
    $(".duration-scale-control"),
    $("#play-position"),
    $("#loop-phrase"),
    $("#lyrics-toggle"),
    follow,
    practiceMenu.details,
    $("#voice").closest("label"),
    $("#volume").closest("label"),
    $("#effects").closest("label"),
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
  let lastId;
  try {
    lastId = JSON.parse(localStorage.getItem(lastScoreKey)) ||
      JSON.parse(localStorage.getItem(draftKey))?.score?.id;
  } catch {}
  const drafts = readDrafts();
  const draft = startupDraft(drafts, lastId);
  if (draft) {
    const saved = nativeScores.find((s) => s.id === draft.score.id);
    if (saved?.archived === true)
      for (const key of [
        "archived",
        "archivedAt",
        "archiveReason",
        "primaryScoreId",
      ])
        if (saved[key] !== undefined) draft.score[key] = saved[key];
    restoreDraft(draft);
  } else if (nativeScores.some((s) => s.id === lastId)) {
    const saved = nativeScores.find((s) => s.id === lastId);
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
  const draft = startupDraft(readDrafts());
  if (draft) {
    restoredDraft = draft;
    openScore(draft.score, { restored: true, changed: true });
  } else openScore(fresh(), { restored: true });
  const message = "读取乐谱库失败：" + err.message +
    (draft ? "。已打开本机草稿，原草稿保留。" : "。已有草稿未改动，可以先写谱。");
  $("#message").textContent = message;
  toast(message);
}
