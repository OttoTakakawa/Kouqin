import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const scores = await (await request.get("/api/scores")).json();
  for (const score of scores) await request.delete("/api/scores/" + score.id);
});
async function reveal(page, selector) {
  const ancestors = await page.locator(selector).evaluate((node) => {
    const result = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement)
      if (parent.tagName === "DETAILS" && !parent.open)
        result.unshift(parent.id);
    return result;
  });
  for (const id of ancestors) await page.locator(`#${id} > summary`).click();
}
async function editor(page) {
  await page.goto("/");
  await expect(page.locator("#score")).toBeVisible();
  await page.locator("#score").click();
}
async function importScore(page, value) {
  await page.locator("#import-open").click();
  await page
    .locator("#import-text")
    .fill(typeof value === "string" ? value : JSON.stringify(value));
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "新建为可编辑草稿" }).click();
  await expect(page.locator("#import-dialog")).not.toBeVisible();
}
function sample(notes, bpm = 90) {
  return {
    version: 1,
    id: "input-demo",
    title: "浏览器验收曲",
    key: "C",
    bpm,
    notes,
  };
}
function note(degree, duration = 1) {
  return { type: "note", degree, octave: 0, sharp: false, duration };
}

test("默认只有主入口，归档版本可恢复且保留未保存编辑，原图仍可访问", async ({
  page,
  request,
}) => {
  const main = {
    ...sample([note(1)]),
    id: "archive-primary",
    title: "旧谱测试（主稿）",
    transcription: { sourceRelativePath: "旧谱测试.md" },
  };
  const old = {
    ...sample([note(3, 2)]),
    id: "archive-old",
    title: "旧谱测试（旧稿）",
    archived: true,
    primaryScoreId: main.id,
  };
  expect((await request.post("/api/scores", { data: main })).ok()).toBeTruthy();
  expect((await request.post("/api/scores", { data: old })).ok()).toBeTruthy();
  await page.goto("/");
  await expect(page.locator(".song")).toHaveCount(1);
  await expect(page.locator("#title")).toHaveValue(main.title);
  await page.locator("#library-filter").selectOption("archived");
  await expect(page.locator(".song")).toHaveCount(1);
  await page.locator(".song").click();
  await expect(page.locator("#restore-archive")).toBeVisible();
  await page.reload();
  await expect(page.locator("#title")).toHaveValue(main.title);
  await page.locator("#library-filter").selectOption("archived");
  await page.locator(".song").click();
  await page.locator("#title").fill("我改过的旧稿");
  page.once("dialog", (d) => d.accept());
  await page.reload();
  await expect(page.locator("#title")).toHaveValue("我改过的旧稿");
  await expect(page.locator("#restore-archive")).toBeVisible();
  const saveResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/scores") && r.request().method() === "POST",
  );
  await page.locator("#restore-archive").click();
  expect((await saveResponse).ok()).toBeTruthy();
  await expect(page.locator("#library-filter")).toHaveValue("native");
  await expect(page.locator(".song")).toHaveCount(2);
  const restored = (await (await request.get("/api/scores")).json()).find(
    (s) => s.id === old.id,
  );
  expect(restored.archived).toBeUndefined();
  expect(restored.title).toBe("我改过的旧稿");
  expect(restored.notes).toEqual(old.notes);
  await page.locator("#library-filter").selectOption("original");
  await expect(page.locator(".song")).toHaveCount(1);
  await page.locator(".song").click();
  await expect(page.locator("#original-view")).toBeVisible();
});

test("倍低音和倍高音导入、显示、保存与重读保持音区", async ({
  page,
  request,
}) => {
  await editor(page);
  const notes = [
    { ...note(7, 0.5), octave: -2 },
    { type: "space" },
    { ...note(2), octave: -1, sharp: true },
    { type: "break" },
    { ...note(1, 2), octave: 2 },
  ];
  await importScore(page, sample(notes));
  await expect(page.locator(".note")).toHaveText(["((7))", "(#2)", "[[1]]"]);
  await expect(page.locator(".space-token")).toHaveText("·");
  const saveResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/scores") &&
      response.request().method() === "POST",
  );
  await page.locator("#save").click();
  expect((await saveResponse).ok()).toBeTruthy();
  const saved = (await (await request.get("/api/scores")).json())[0];
  expect(saved.notes).toEqual(notes);
  await page.reload();
  await expect(page.locator(".note")).toHaveText(["((7))", "(#2)", "[[1]]"]);
});

test("灰色停可原位设置时长并真正静音，短音字号不同，批量校音保留分组", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...args) {
      const result = connect.call(this, destination, ...args);
      if (destination instanceof AudioDestinationNode) {
        const analyser = this.context.createAnalyser();
        connect.call(this, analyser);
        window.__gapAnalyser = analyser;
      }
      return result;
    };
  });
  await editor(page);
  await importScore(
    page,
    sample(
      [
        note(1, 0.25),
        { type: "space" },
        note(2, 0.5),
        { type: "space" },
        note(3, 1),
      ],
      120,
    ),
  );
  const sizes = await page
    .locator(".note")
    .evaluateAll((nodes) =>
      nodes.map((n) => parseFloat(getComputedStyle(n).fontSize)),
    );
  expect(sizes[1] - sizes[0]).toBeGreaterThanOrEqual(4);
  expect(sizes[2] - sizes[1]).toBeGreaterThanOrEqual(4);
  await page.locator(".space-token").first().click();
  await expect(page.locator("#duration-feel")).toBeEnabled();
  await expect(page.locator("#duration-feel")).toHaveValue("");
  await expect(page.locator('#duration-feel option[value="0"]')).toHaveCount(0);
  await page.locator("#duration-feel").selectOption("2");
  await expect(page.locator(".pause-token")).toHaveText("停");
  await expect(page.locator(".space-token")).toHaveCount(1);
  await expect(page.locator("#duration-feel")).toHaveValue("2");
  await page.keyboard.press("c");
  await expect(page.locator("#duration-feel")).toHaveValue("1");
  await page.keyboard.press("z");
  await expect(page.locator("#duration-feel")).toHaveValue("2");
  for (let i = 0; i < 3; i++) await page.locator("#undo").click();
  await expect(page.locator(".pause-token")).toHaveCount(0);
  await expect(page.locator(".space-token")).toHaveCount(2);
  for (let i = 0; i < 3; i++) await page.locator("#redo").click();
  await expect(page.locator(".pause-token")).toHaveCount(1);
  const saveResponse = page.waitForResponse(
    (r) => r.url().endsWith("/api/scores") && r.request().method() === "POST",
  );
  await page.locator("#save").click();
  expect((await saveResponse).ok()).toBeTruthy();
  const saved = (await (await request.get("/api/scores")).json())[0];
  expect(saved.notes).toEqual([
    note(1, 0.25),
    note(0, 2),
    note(2, 0.5),
    { type: "space" },
    note(3, 1),
  ]);
  await page.reload();
  await expect(page.locator(".pause-token")).toHaveText("停");
  await page.locator(".pause-token").click();
  await expect(page.locator("#duration-feel")).toHaveValue("2");
  await reveal(page, "#voice");
  await page.locator("#voice").selectOption("synth");
  await page.locator("#playback-settings > summary").click();
  await page.locator(".note").first().click();
  await page.locator("#play").click();
  await expect(page.locator(".pause-token.playing")).toHaveAttribute(
    "data-index",
    "1",
  );
  await page.waitForTimeout(100);
  const peak = await page.evaluate(() => {
    const a = window.__gapAnalyser,
      v = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(v);
    return Math.max(...v.map(Math.abs));
  });
  expect(peak).toBeLessThan(0.001);
  await page.waitForFunction(
    () => document.querySelector(".note.playing")?.dataset.index === "2",
  );
  await page.locator("#stop").click();
  await page.locator(".note").first().click();
  await page
    .locator(".note")
    .last()
    .click({ modifiers: ["Shift"] });
  await page.locator("#duration-feel").selectOption("1");
  await expect(page.locator(".space-token")).toHaveCount(1);
  await expect(page.locator(".pause-token")).toHaveCount(1);
  await page.locator("#undo").click();
  await page.locator(".space-token").click();
  await page.locator("#pause-menu > summary").click();
  await page.locator('[data-pause="1"]').click();
  await expect(page.locator(".pause-token")).toHaveCount(2);
  await expect(page.locator(".space-token")).toHaveCount(0);
});

test("点击09选中整句并显示箭头，隐藏插入光标，从句首播放", async ({ page }) => {
  await editor(page);
  const notes = [];
  for (let i = 0; i < 9; i++) {
    if (i) notes.push({ type: "break" });
    notes.push(note(1, 0.5), { type: "space" }, note(3, 1));
  }
  await importScore(page, sample(notes));
  const row = page.locator(".phrase").nth(8);
  await row.locator(".line-number").click();
  await expect(row).toHaveClass(/row-selected/);
  await expect(row.locator(".line-number")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(row.locator(".note.chosen")).toHaveCount(2);
  await expect(page.locator(".caret")).toHaveCount(0);
  expect(
    await row.evaluate((el) => getComputedStyle(el, "::before").content),
  ).toBe('"▶"');
  await expect(page.locator("#playback-cue")).toHaveText("9句·1音");
  await page.locator("#play").click();
  await expect(page.locator(".note.playing")).toHaveAttribute(
    "data-index",
    "32",
  );
  await page.locator("#stop").click();
  await row.locator(".note").last().click();
  await expect(row).not.toHaveClass(/row-selected/);
  await expect(row.locator(".note.chosen")).toHaveCount(1);
  await expect(page.locator(".caret")).toHaveCount(1);
});

test("分数音长、尾音延长和段后留白，保存撤销与实际静音", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...args) {
      const result = connect.call(this, dest, ...args);
      if (dest instanceof AudioDestinationNode) {
        const a = this.context.createAnalyser();
        connect.call(this, a);
        window.__gapAnalyser = a;
      }
      return result;
    };
  });
  await editor(page);
  await importScore(
    page,
    sample([note(1, 1), note(2, 0.5), { type: "break" }, note(3, 1)], 120),
  );
  await expect(page.locator("#bpm")).not.toBeVisible();
  await expect(page.locator("#scope")).not.toBeVisible();
  await expect(page.locator("#note-duration-name")).not.toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "音长", exact: true }),
  ).toBeVisible();
  await page.locator(".note").nth(0).click();
  await page
    .locator(".note")
    .nth(1)
    .click({ modifiers: ["Shift"] });
  await page.locator("#tail-menu > summary").click();
  await page.locator('[data-hold="1"]').click();
  await expect(page.locator(".tail-hold")).toHaveCount(1);
  await page.locator("#pause-menu > summary").click();
  await page.locator('[data-pause="2"]').click();
  await expect(page.locator(".pause-token")).toHaveCount(1);
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  let saved = (await (await request.get("/api/scores")).json())[0];
  expect(saved.notes).toEqual([
    note(1, 1),
    { ...note(2, 0.5), tailHold: 1 },
    note(0, 2),
    { type: "break" },
    note(3, 1),
  ]);
  await page.locator("#pause-menu > summary").click();
  await page.locator('[data-pause="4"]').click();
  await expect(page.locator(".pause-token")).toHaveCount(1);
  await page.locator("#undo").click();
  await reveal(page, "#voice");
  await page.locator("#voice").selectOption("synth");
  await page.locator(".note").first().click();
  await page.locator("#play").click();
  await expect(page.locator(".note.playing")).toHaveAttribute(
    "data-index",
    "2",
  );
  await page.waitForTimeout(100);
  const peak = await page.evaluate(() => {
    const a = window.__gapAnalyser,
      v = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(v);
    return Math.max(...v.map(Math.abs));
  });
  expect(peak).toBeLessThan(0.001);
  await expect(page.locator(".note.playing")).toHaveAttribute(
    "data-index",
    "4",
  );
  await page.locator("#stop").click();
  await page.locator(".pause-token").click();
  await page.locator("#pause-menu > summary").click();
  await page.locator('[data-pause="0"]').click();
  await expect(page.locator(".pause-token")).toHaveCount(0);
  await page.locator("#undo").click();
  await expect(page.locator(".pause-token")).toHaveCount(1);
  await page.locator(".note").nth(1).click();
  await page.locator("#tail-menu > summary").click();
  await page.locator('[data-hold="0"]').click();
  await expect(page.locator(".tail-hold")).toHaveCount(0);
  await expect(page.locator("#duration-feel")).toHaveValue("0.5");
});

test("桌面乐谱列表和分类可折叠，刷新后保持，搜索时展开匹配分类", async ({
  page,
}) => {
  await editor(page);
  await importScore(page, sample([note(1)]));
  await page.locator("#category").fill("日系");
  await page.locator("#category").press("Tab");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  const category = page
    .locator(".category-group")
    .filter({ has: page.locator(".category-heading", { hasText: "日系" }) });
  await category.locator("summary").click();
  await expect(category).not.toHaveAttribute("open", "");
  await page.reload();
  await expect(category).not.toHaveAttribute("open", "");
  await page.locator("#search").fill("浏览器验收曲");
  await expect(category).toHaveAttribute("open", "");
  const toggle = page.getByRole("button", { name: "显示或隐藏乐谱库" });
  await toggle.click();
  await expect(page.locator(".sidebar")).not.toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.reload();
  await expect(page.locator(".sidebar")).not.toBeVisible();
  await toggle.click();
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("识图估计值载入时保留，单音可按名称校准并撤销", async ({
  page,
  request,
}) => {
  await editor(page);
  const notes = [note(3, 2.5), note(3, 1.1)];
  await importScore(page, sample(notes));
  await expect(page.locator("#note-duration-name")).toHaveText("拍 · 自定音长");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  expect((await (await request.get("/api/scores")).json())[0].notes).toEqual(
    notes,
  );
  await page.locator(".note").first().click();
  await expect(page.locator("#apply-batch-duration")).toBeDisabled();
  await reveal(page, "#batch-duration");
  await page
    .getByRole("combobox", { name: "标准音长", exact: true })
    .selectOption("1");
  await reveal(page, "#apply-batch-duration");
  await page.locator("#apply-batch-duration").click();
  await expect(page.locator("#note-duration-name")).toHaveText("拍 · 四分音符");
  await page.locator("#undo").click();
  await expect(page.locator("#note-duration")).toHaveText("2.5");
  await expect(page.locator("#note-duration-name")).toHaveText("拍 · 自定音长");
});

test("统一速度兼容旧倍率，预设、撤销和保存不再叠加倍率", async ({
  page,
  request,
}) => {
  await editor(page);
  const notes = [note(1, 0.5), note(2, 1.5), note(0, 1)];
  await importScore(page, { ...sample(notes, 60), durationScale: 0.5 });
  const speed = page.getByRole("slider", { name: "播放速度", exact: true });
  await expect(speed).toHaveValue("120");
  await expect(page.locator("#bpm")).toHaveCount(0);
  await expect(page.locator("#duration-scale-value")).toHaveText("120 BPM");
  const sizes = await page
    .locator(".note")
    .evaluateAll((nodes) => nodes.map((n) => n.style.fontSize));
  await page
    .getByRole("combobox", { name: "速度预设", exact: true })
    .selectOption("60");
  await expect(speed).toHaveValue("60");
  await expect(page.locator("#play-position")).toHaveText("00:00 / 00:03");
  await page.locator("#undo").click();
  await expect(speed).toHaveValue("120");
  await page.locator("#redo").click();
  await expect(speed).toHaveValue("60");
  await speed.evaluate((input) => {
    input.value = "120";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(
    await page
      .locator(".note")
      .evaluateAll((nodes) => nodes.map((n) => n.style.fontSize)),
  ).toEqual(sizes);
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  const saved = (await (await request.get("/api/scores")).json())[0];
  expect(saved.bpm).toBe(120);
  expect(saved.durationScale).toBeUndefined();
  expect(saved.notes).toEqual(notes);
  await page.reload();
  await expect(speed).toHaveValue("120");
  await reveal(page, "#voice");
  await page.locator("#voice").selectOption("synth");
  await page.locator("#playback-settings > summary").click();
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "播放", {
    timeout: 4000,
  });
});

test("编辑模式重复点击行号起播，本行循环可编辑且不进入下一行", async ({
  page,
}) => {
  await editor(page);
  await importScore(
    page,
    sample([note(1, 0.5), note(2, 0.5), { type: "break" }, note(7, 1)], 240),
  );
  await reveal(page, "#voice");
  await page.locator("#voice").selectOption("synth");
  await page.locator("#playback-settings > summary").click();
  await page.evaluate(() => {
    window.__heard = [];
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) {
      window.__heard.push(this.frequency.value);
      return start.apply(this, args);
    };
  });
  const row = page.locator(".phrase").first();
  await row.locator(".line-number").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "播放");
  await row.locator(".line-number").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await page.locator("#stop").click();
  await page.evaluate(() => (window.__heard = []));
  await page.getByRole("button", { name: "循环本行", exact: true }).click();
  await expect(page.locator("#loop-phrase")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.waitForFunction(() => window.__heard.length >= 6);
  expect(await page.evaluate(() => window.__heard.every((f) => f < 400))).toBe(
    true,
  );
  await row.locator(".note").first().click();
  await page.locator("#lengthen").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await expect(page.locator("#loop-phrase")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__heard.every((f) => f < 400))).toBe(
    true,
  );
  await page.locator("#stop").click();
  await row.locator(".line-number").click();
  await row.locator(".line-number").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await page.locator("#loop-phrase").click();
  await expect(page.locator("#loop-phrase")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("连续多选统一音长，整句选择与批量 Z/C，撤销一次恢复混合时值", async ({
  page,
  request,
}) => {
  await editor(page);
  const notes = [
    note(3, 0.5),
    { type: "space" },
    note(3, 1.5),
    note(3, 1.5),
    { type: "break" },
    note(6, 2),
    note(0, 1),
  ];
  await importScore(page, sample(notes));
  await page.locator(".note").nth(0).click();
  await page
    .locator(".note")
    .nth(2)
    .click({ modifiers: ["Shift"] });
  await expect(page.locator(".note.chosen")).toHaveCount(3);
  await expect(page.locator("#selected-label")).toHaveText("3 个");
  await expect(page.locator("#note-duration")).toHaveText("混合");
  await reveal(page, "#batch-duration");
  await expect(
    page.getByRole("combobox", { name: "标准音长", exact: true }),
  ).toHaveValue("0.5");
  await reveal(page, "#batch-duration");
  await page.locator("#batch-duration").selectOption("0.75");
  await reveal(page, "#batch-duration");
  await page.locator("#batch-duration").press("Enter");
  await expect(page.locator("#note-duration")).toHaveText("0.75");
  expect(
    await page
      .locator(".note.chosen")
      .evaluateAll((ns) => new Set(ns.map((n) => n.style.fontSize)).size),
  ).toBe(1);
  await page.locator("#undo").click();
  await expect(page.locator("#note-duration")).toHaveText("混合");
  await page.locator("#redo").click();
  await expect(page.locator("#note-duration")).toHaveText("0.75");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  let saved = (await (await request.get("/api/scores")).json())[0];
  expect(saved.notes).toEqual(
    notes.map((n) =>
      n.type === "note" && n.degree === 3 ? { ...n, duration: 0.75 } : n,
    ),
  );
  await reveal(page, "#select-phrase");
  await page.locator("#select-phrase").click();
  await expect(page.locator(".note.chosen")).toHaveCount(3);
  await page.keyboard.press("z");
  await expect(page.locator("#note-duration")).toHaveText("1");
  await page.keyboard.press("Shift+c");
  await expect(page.locator("#note-duration")).toHaveText("0.75");
  await page.locator(".note").last().click();
  await reveal(page, "#select-phrase");
  await page.locator("#select-phrase").click();
  await expect(page.locator(".note.chosen")).toHaveCount(2);
  await expect(page.locator('#batch-duration option[value="9"]')).toHaveCount(
    0,
  );
  await expect(page.locator("#note-duration")).toHaveText("混合");
  await reveal(page, "#batch-duration");
  await page.locator("#batch-duration").selectOption("0.5");
  await reveal(page, "#apply-batch-duration");
  await page.locator("#apply-batch-duration").click();
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  saved = (await (await request.get("/api/scores")).json())[0];
  expect(saved.notes.slice(5).map((n) => n.duration)).toEqual([0.5, 0.5]);
  expect(saved.notes.slice(0, 5)).toEqual(
    notes
      .slice(0, 5)
      .map((n) => (n.type === "note" ? { ...n, duration: 0.75 } : n)),
  );
});

test("实际键盘写谱、音长、撤销、保存重开、导出与再次导入", async ({
  page,
  request,
}) => {
  await editor(page);
  await page.keyboard.press("1");
  await page.keyboard.press("Shift+2");
  await page.keyboard.press("Control+3");
  await page.keyboard.press("Alt+4");
  await page.keyboard.press("Shift+Alt+5");
  await expect(page.locator(".note")).toHaveText([
    "1",
    "[2]",
    "(3)",
    "#4",
    "[#5]",
  ]);
  await page.keyboard.press("z");
  await expect(page.locator("#note-duration")).toHaveText("2");
  await page.keyboard.press("Shift+c");
  await expect(page.locator("#note-duration")).toHaveText("1.5");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#note-duration")).toHaveText("2");
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator("#note-duration")).toHaveText("1.5");
  await page.keyboard.press("Enter");
  await page.keyboard.type("670");
  await expect(page.locator(".phrase")).toHaveCount(2);
  await page.locator("#title").fill("我的验收乐谱");
  await page.locator("#category").fill("日系");
  await page.locator("#category").press("Tab");
  await page.locator("#key").selectOption("A");
  await page.locator("#status").selectOption("练习中");
  await page.locator("#favorite").click();
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  let saved = await (await request.get("/api/scores")).json();
  expect(saved).toHaveLength(1);
  expect(saved[0].notes[4].duration).toBe(1.5);
  expect(saved[0].key).toBe("A");
  await page.reload();
  await expect(page.locator("#title")).toHaveValue("我的验收乐谱");
  await expect(page.locator(".note")).toHaveCount(8);
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("我的验收乐谱.json");
  const { readFile } = await import("node:fs/promises");
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(exported.notes).toEqual(saved[0].notes);
  await page.locator("#library-filter").selectOption("favorite");
  await expect(page.locator(".song")).toHaveCount(1);
  await page.locator("#search").fill("不存在");
  await expect(page.locator(".song")).toHaveCount(0);
  await page.locator("#search").fill("");
  await importScore(page, saved[0]);
  await expect(page.locator(".note")).toHaveCount(8);
  await expect(page.locator("#key")).toHaveValue("A");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  saved = await (await request.get("/api/scores")).json();
  expect(saved).toHaveLength(2);
});

test("分句复制、选择删除、草稿恢复、自定义快捷键、特效持久化与主题", async ({
  page,
}) => {
  await editor(page);
  await page.keyboard.type("123");
  await reveal(page, "#duplicate");
  await page.locator("#duplicate").click();
  await expect(page.locator(".note")).toHaveCount(6);
  await expect(page.locator(".phrase")).toHaveCount(2);
  await page.locator("#score").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".note")).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".note")).toHaveCount(6);
  await reveal(page, "#effects");
  await page.locator("#effects").uncheck();
  await page.locator("#settings-open").click();
  await page.locator("[name=longer]").fill("q");
  await page.locator("[name=shorter]").fill("w");
  await page.locator("[name=newline]").selectOption("Tab");
  await page.locator("#theme").selectOption("dark");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(page.locator("body")).toHaveAttribute("data-theme", "dark");
  await page.locator(".note").last().click();
  await page.keyboard.press("q");
  await expect(page.locator("#note-duration")).toHaveText("2");
  await page.keyboard.press("Tab");
  await expect(page.locator(".phrase")).toHaveCount(3);
  page.once("dialog", (d) => d.accept());
  await page.reload();
  await expect(page.locator(".note")).toHaveCount(6);
  await expect(page.locator("#effects")).not.toBeChecked();
  await expect(page.locator("body")).toHaveClass(/no-effects/);
  await expect(page.locator("body")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("#save-state")).toHaveClass(/dirty/);
  await page.locator("#practice-mode").click();
  await expect(page.locator(".sidebar")).not.toBeVisible();
  await expect(page.locator(".note-tools")).not.toBeVisible();
});

test("现有收藏只读，新建可校对草稿；畸形 JSON / 括号给出错误", async ({
  page,
}) => {
  await editor(page);
  await page.getByRole("button", { name: /旧谱测试/ }).click();
  await expect(page.locator("#original-view")).toBeVisible();
  await expect(page.locator("#save")).toBeDisabled();
  await page.locator("#original-import").click();
  await expect(page.locator("#import-text")).toHaveValue(/12\(67\)/);
  await page.getByRole("button", { name: "新建为可编辑草稿" }).click();
  await expect(page.locator(".note")).toHaveCount(13);
  await page.locator("#import-open").click();
  await page.locator("#import-text").fill("(12");
  await page.getByRole("button", { name: "新建为可编辑草稿" }).click();
  await expect(page.locator("#import-error")).toContainText("括号");
  await page.locator("#import-text").fill('{"bad":1}');
  await page.getByRole("button", { name: "新建为可编辑草稿" }).click();
  await expect(page.locator("#import-error")).toContainText("格式");
});

test("本地口琴采样真实出声、暂停继续、关特效仍跟谱，合成音可用", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.__contexts = [];
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor(...args) {
        super(...args);
        window.__contexts.push(this);
      }
    };
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...args) {
      const result = connect.call(this, destination, ...args);
      if (destination instanceof AudioDestinationNode) {
        const analyser = this.context.createAnalyser();
        connect.call(this, analyser);
        window.__analyser = analyser;
      }
      return result;
    };
  });
  await editor(page);
  await importScore(
    page,
    sample([note(1, 4), note(3, 2), { type: "break" }, note(5, 2)], 120),
  );
  await reveal(page, "#effects");
  await page.locator("#effects").uncheck();
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const a = window.__analyser;
        if (!a) return 0;
        const values = new Float32Array(a.fftSize);
        a.getFloatTimeDomainData(values);
        return Math.max(...values.map(Math.abs));
      }),
    )
    .toBeGreaterThan(0.001);
  await expect(page.locator(".note.playing")).toHaveCount(1);
  expect(
    await page
      .locator(".note.playing")
      .evaluate((n) => getComputedStyle(n, "::after").display),
  ).toBe("none");
  await page.locator("#practice-mode").click();
  await expect(page.locator(".note.playing")).toHaveCount(1);
  await page.locator("#edit-mode").click();
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "继续");
  const time = await page.locator("#play-position").textContent();
  await page.waitForTimeout(250);
  await expect(page.locator("#play-position")).toHaveText(time);
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await page.locator("#stop").click();
  await expect(page.locator(".note.playing")).toHaveCount(0);
  await reveal(page, "#voice");
  await page.locator("#voice").selectOption("synth");
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const a = window.__analyser;
        const v = new Float32Array(a.fftSize);
        a.getFloatTimeDomainData(v);
        return Math.max(...v.map(Math.abs));
      }),
    )
    .toBeGreaterThan(0.001);
  await page.locator("#stop").click();
});

test("口琴延音保持原音高，循环接入后 A3 不降成 G3", async ({ page }) => {
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...args) {
      const result = connect.call(this, dest, ...args);
      if (dest instanceof AudioDestinationNode) {
        const analyser = this.context.createAnalyser();
        analyser.fftSize = 16384;
        connect.call(this, analyser);
        window.__pitchAnalyser = analyser;
      }
      return result;
    };
  });
  await editor(page);
  await importScore(page, sample([{ ...note(6, 6), octave: -1 }], 60));
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  // Past the 3.13-second source file, so this measures the sustained loop.
  await page.waitForTimeout(4200);
  const frequency = await page.evaluate(() => {
    const a = window.__pitchAnalyser,
      values = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(values);
    const binWidth = a.context.sampleRate / a.fftSize;
    let peak = Math.ceil(170 / binWidth);
    for (let i = peak + 1; i < Math.floor(250 / binWidth); i++)
      if (values[i] > values[peak]) peak = i;
    return peak * binWidth;
  });
  expect(Math.abs(frequency - 220)).toBeLessThan(4);
  await page.locator("#stop").click();
});

test("16 秒长音在末段仍有声音，播放正常结束", async ({ page }) => {
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...args) {
      const result = connect.call(this, dest, ...args);
      if (dest instanceof AudioDestinationNode) {
        const a = this.context.createAnalyser();
        connect.call(this, a);
        window.__analyser = a;
      }
      return result;
    };
  });
  await editor(page);
  await importScore(page, sample([note(1, 8)], 30));
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await page.waitForTimeout(14500);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const a = window.__analyser;
        const v = new Float32Array(a.fftSize);
        a.getFloatTimeDomainData(v);
        return Math.max(...v.map(Math.abs));
      }),
    )
    .toBeGreaterThan(0.001);
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "播放", {
    timeout: 5000,
  });
});

test("小屏布局可写谱并能打开曲目库", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await editor(page);
  await page.keyboard.type("123");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await expect(page.locator("#play")).toBeVisible();
  await page.getByRole("button", { name: "显示或隐藏乐谱库" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
});

test("点击起播、播放中跳转、暂停后定位，练习点击不改变编辑选区", async ({
  page,
}) => {
  await editor(page);
  await importScore(
    page,
    sample([note(1, 2), note(2, 2), note(3, 2), note(4, 2), note(5, 2)], 120),
  );
  await reveal(page, "#voice");
  await page.locator("#voice").selectOption("synth");
  await page.locator(".note").nth(2).click();
  await page.locator("#play").click();
  await expect(page.locator(".note.playing")).toHaveAttribute(
    "data-index",
    "2",
  );
  await page.locator(".note").nth(4).click();
  await expect(page.locator(".note.playing")).toHaveAttribute(
    "data-index",
    "4",
  );
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "继续");
  await page.locator(".note").nth(1).click();
  await page.locator("#play").click();
  await expect(page.locator(".note.playing")).toHaveAttribute(
    "data-index",
    "1",
  );
  await page.locator("#practice-mode").click();
  await page.locator(".note").nth(3).click();
  await expect(page.locator(".note.playing")).toHaveAttribute(
    "data-index",
    "3",
  );
  await page.locator("#edit-mode").click();
  await expect(page.locator(".note.chosen")).toHaveAttribute("data-index", "1");
  await reveal(page, "#play-from-start");
  await page.locator("#play-from-start").click();
  await expect(page.locator(".note.playing")).toHaveAttribute(
    "data-index",
    "0",
  );
  await page.locator("#stop").click();
  await page.locator(".note").nth(2).dblclick();
  await expect(page.locator(".note.playing")).toHaveAttribute(
    "data-index",
    "2",
  );
  await page.locator("#stop").click();
});

test("跨句 A/B 循环包含尾音、不串区间，并与编辑选区及模式分离", async ({
  page,
}) => {
  await editor(page);
  await importScore(
    page,
    sample(
      [
        note(1, 0.6),
        note(2, 0.6),
        { type: "space" },
        note(3, 0.6),
        { type: "break" },
        note(4, 0.6),
        note(5, 0.6),
      ],
      120,
    ),
  );
  await reveal(page, "#voice");
  await page.locator("#voice").selectOption("synth");
  await page.locator(".note").nth(1).click();
  await reveal(page, "#set-loop-a");
  await page.locator("#set-loop-a").click();
  await page.locator(".note").nth(3).click();
  await reveal(page, "#set-loop-b");
  await page.locator("#set-loop-b").click();
  await expect(page.locator("#scope")).toHaveValue("ab");
  await expect(page.locator("#loop")).toBeChecked();
  await expect(page.locator(".note.loop-range")).toHaveCount(3);
  await page.locator("#practice-mode").click();
  await page.locator("#edit-mode").click();
  await page.locator(".note").nth(2).click();
  await page
    .locator(".note")
    .nth(3)
    .click({ modifiers: ["Shift"] });
  await expect(page.locator("#loop-a")).toHaveText("A 1句·2音");
  await expect(page.locator("#loop-b")).toHaveText("B 2句·1音");
  await page.evaluate(() => {
    window.__visited = [];
    window.__watch = setInterval(() => {
      const n = document.querySelector(".note.playing");
      if (n) window.__visited.push(Number(n.dataset.index));
    }, 10);
  });
  await page.locator("#play").click();
  await page.waitForTimeout(2200);
  const visited = await page.evaluate(() => {
    clearInterval(window.__watch);
    return [...new Set(window.__visited)];
  });
  expect(visited.sort((a, b) => a - b)).toEqual([1, 3, 5]);
  await reveal(page, "#clear-loop-points");
  await page.locator("#clear-loop-points").click();
  await expect(page.locator("#scope")).toHaveValue("all");
  await expect(page.locator("#loop")).not.toBeChecked();
  await expect(page.locator("[data-loop-marker]")).toHaveCount(0);
  await reveal(page, "#loop-selection");
  await page.locator("#loop-selection").click();
  await expect(page.locator(".note.loop-range")).toHaveCount(2);
  await expect(page.locator("#scope")).toHaveValue("ab");
});

test("当前句循环不串句、关闭循环后结束；剪贴板保留音长", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await editor(page);
  await importScore(
    page,
    sample([note(1, 0.5), { type: "break" }, note(5, 0.5)], 120),
  );
  await page.locator(".note").last().click();
  await reveal(page, "#scope");
  await page.locator("#scope").selectOption("phrase");
  await reveal(page, "#loop");
  await page.locator("#loop").check();
  await reveal(page, "#voice");
  await page.locator("#voice").selectOption("synth");
  await page.locator("#play").click();
  await page.waitForTimeout(900);
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await expect(page.locator(".note.playing")).toHaveAttribute(
    "data-index",
    "2",
  );
  await reveal(page, "#loop");
  await page.locator("#loop").uncheck();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "播放");
  await page.locator(".note").last().click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("End");
  await page.keyboard.press("Control+v");
  await expect(page.locator(".note")).toHaveCount(3);
  await expect(page.locator("#note-duration")).toHaveText("0.5");
});

test("免费MusyngKite离线播放、长音延续、切换静音和偏好恢复", async ({
  page,
}) => {
  const remote = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url()) && !r.url().startsWith("http://127.0.0.1:"))
      remote.push(r.url());
  });
  await page.addInitScript(() => {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (dest, ...args) {
      const result = connect.call(this, dest, ...args);
      if (dest instanceof AudioDestinationNode) {
        const a = this.context.createAnalyser();
        connect.call(this, a);
        window.__analyser = a;
      }
      return result;
    };
  });
  await editor(page);
  await importScore(page, sample([note(1, 8)], 120));
  await reveal(page, "#voice");
  await page.locator("#voice").selectOption("musyngkite");
  await page.locator("#playback-settings > summary").click();
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await page.waitForTimeout(3400);
  const amplitude = () =>
    page.evaluate(() => {
      const a = window.__analyser;
      if (!a) return 0;
      const v = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(v);
      return Math.max(...v.map(Math.abs));
    });
  await expect.poll(amplitude).toBeGreaterThan(0.001);
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "继续");
  await expect.poll(amplitude).toBeLessThan(0.001);
  await page.locator("#play").click();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await expect.poll(amplitude).toBeGreaterThan(0.001);
  await reveal(page, "#voice");
  await page.locator("#voice").selectOption("harmonica");
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "播放");
  await expect.poll(amplitude).toBeLessThan(0.001);
  await page.locator("#play").click();
  await expect.poll(amplitude).toBeGreaterThan(0.001);
  await page.locator("#voice").selectOption("musyngkite");
  await page.locator("#play").click();
  await expect.poll(amplitude).toBeGreaterThan(0.001);
  await page.locator("#stop").click();
  await page.reload();
  await reveal(page, "#voice");
  await expect(page.locator("#voice")).toHaveValue("musyngkite");
  expect(remote).toEqual([]);
});

test("空格插入四分休止，整行和多选绝不被替换，撤销保存保持原音", async ({
  page,
  request,
}) => {
  await editor(page);
  const original = [note(1), note(2), note(3), { type: "break" }, note(5)];
  await importScore(page, sample(original));
  await page.locator(".line-number").first().click();
  await page.keyboard.press("Space");
  await expect(page.locator(".note")).toHaveCount(5);
  await expect(page.locator(".pause-token")).toHaveCount(1);
  await expect(page.locator("#duration-feel")).toHaveValue("1");
  await expect(
    page.getByRole("option", { name: "不停", exact: true }),
  ).toHaveCount(0);
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  let saved = (await (await request.get("/api/scores")).json())[0];
  expect(saved.notes).toEqual([
    ...original.slice(0, 3),
    note(0),
    ...original.slice(3),
  ]);
  await page.locator("#undo").click();
  await expect(page.locator(".pause-token")).toHaveCount(0);
  await expect(page.locator(".note")).toHaveCount(4);
  await page.locator(".note").first().click();
  await page
    .locator(".note")
    .nth(1)
    .click({ modifiers: ["Shift"] });
  await page.keyboard.press("Space");
  await expect(page.locator(".note")).toHaveCount(5);
  await expect(page.locator("#duration-feel")).toHaveValue("1");
  await page.locator("#score").press("Control+a");
  await page.keyboard.press("Space");
  await expect(page.locator(".note")).toHaveCount(6);
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  saved = (await (await request.get("/api/scores")).json())[0];
  expect(saved.notes.filter((n) => n.type === "note" && n.degree > 0)).toEqual(
    original.filter((n) => n.type === "note"),
  );
  expect(
    saved.notes
      .filter((n) => n.type === "note" && n.degree === 0)
      .every((n) => n.duration === 1),
  ).toBe(true);
});

for (const voice of ["generaluser", "vcsl-normal", "vcsl-soft", "vcsl-vib"]) {
  test(`免费音色${voice}持续长音、静音切换、音区和离线加载`, async ({
    page,
  }) => {
    const remote = [];
    page.on("request", (r) => {
      if (/^https?:/.test(r.url()) && !r.url().startsWith("http://127.0.0.1:"))
        remote.push(r.url());
    });
    await page.addInitScript(() => {
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (dest, ...args) {
        const result = connect.call(this, dest, ...args);
        if (dest instanceof AudioDestinationNode) {
          const a = this.context.createAnalyser();
          a.fftSize = 16384;
          connect.call(this, a);
          window.__analyser = a;
        }
        return result;
      };
    });
    await editor(page);
    await importScore(page, sample([note(1, 8)], 60));
    await reveal(page, "#voice");
    await page.locator("#voice").selectOption(voice);
    await page.locator("#playback-settings > summary").click();
    await page.locator("#play").click();
    await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
    await page.waitForTimeout(7350);
    const signal = await page.evaluate(() => {
      const a = window.__analyser;
      const v = new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(v);
      const spectrum = new Float32Array(a.frequencyBinCount);
      a.getFloatFrequencyData(spectrum);
      let peakBin = Math.round((220 * a.fftSize) / a.context.sampleRate);
      for (
        let i = peakBin + 1;
        i < Math.round((310 * a.fftSize) / a.context.sampleRate);
        i++
      )
        if (spectrum[i] > spectrum[peakBin]) peakBin = i;
      return {
        peak: Math.max(...v.map(Math.abs)),
        frequency: (peakBin * a.context.sampleRate) / a.fftSize,
      };
    });
    expect(signal.peak).toBeGreaterThan(0.001);
    expect(signal.peak).toBeLessThan(0.95);
    expect(signal.frequency).toBeGreaterThan(250);
    expect(signal.frequency).toBeLessThan(275);
    await page.locator("#stop").click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const a = window.__analyser,
            v = new Float32Array(a.fftSize);
          a.getFloatTimeDomainData(v);
          return Math.max(...v.map(Math.abs));
        }),
      )
      .toBeLessThan(0.001);
    await page.reload();
    await reveal(page, "#voice");
    await expect(page.locator("#voice")).toHaveValue(voice);
    expect(remote).toEqual([]);
  });
}

test("每首独立保存BPM，切换和刷新不串用上一首速度", async ({
  page,
  request,
}) => {
  const first = {
    ...sample([note(1)], 60),
    id: "tempo-first",
    title: "速度甲",
  };
  const second = {
    ...sample([note(2)], 160),
    id: "tempo-second",
    title: "速度乙",
  };
  await request.post("/api/scores", { data: first });
  await request.post("/api/scores", { data: second });
  await page.goto("/");
  await page.locator("#search").fill("速度甲");
  await page.locator(".song").click();
  await expect(page.locator("#duration-scale")).toHaveValue("60");
  await page.locator("#tempo-preset").selectOption("120");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  await page.locator("#search").fill("速度乙");
  await page.locator(".song").click();
  await expect(page.locator("#duration-scale")).toHaveValue("160");
  await page.reload();
  await expect(page.locator("#duration-scale")).toHaveValue("160");
  await page.locator("#search").fill("速度甲");
  await page.locator(".song").click();
  await expect(page.locator("#duration-scale")).toHaveValue("120");
  const scores = await (await request.get("/api/scores")).json();
  expect(scores.find((s) => s.id === first.id).bpm).toBe(120);
  expect(scores.find((s) => s.id === second.id).bpm).toBe(160);
});
