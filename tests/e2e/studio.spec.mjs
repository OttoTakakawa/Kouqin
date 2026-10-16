import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const scores = await (await request.get("/api/scores")).json();
  for (const score of scores) await request.delete("/api/scores/" + score.id);
});
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
  await expect(page.locator("#note-duration")).toHaveText("1.125");
  await page.keyboard.press("Shift+c");
  await expect(page.locator("#note-duration")).toHaveText("1.1");
  await page.keyboard.press("Control+z");
  await expect(page.locator("#note-duration")).toHaveText("1.125");
  await page.keyboard.press("Control+Shift+z");
  await expect(page.locator("#note-duration")).toHaveText("1.1");
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
  expect(saved[0].notes[4].duration).toBe(1.1);
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
  await page.locator("#duplicate").click();
  await expect(page.locator(".note")).toHaveCount(6);
  await expect(page.locator(".phrase")).toHaveCount(2);
  await page.locator("#score").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await expect(page.locator(".note")).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".note")).toHaveCount(6);
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
  await expect(page.locator("#note-duration")).toHaveText("1.125");
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

test("当前句循环不串句、关闭循环后结束；剪贴板保留音长", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await editor(page);
  await importScore(
    page,
    sample([note(1, 0.5), { type: "break" }, note(5, 0.5)], 120),
  );
  await page.locator(".note").last().click();
  await page.locator("#scope").selectOption("phrase");
  await page.locator("#loop").check();
  await page.locator("#voice").selectOption("synth");
  await page.locator("#play").click();
  await page.waitForTimeout(900);
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "暂停");
  await expect(page.locator(".note.playing")).toHaveAttribute(
    "data-index",
    "2",
  );
  await page.locator("#loop").uncheck();
  await expect(page.locator("#play")).toHaveAttribute("aria-label", "播放");
  await page.locator(".note").last().click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("End");
  await page.keyboard.press("Control+v");
  await expect(page.locator(".note")).toHaveCount(3);
  await expect(page.locator("#note-duration")).toHaveText("0.5");
});
