import { test, expect } from "@playwright/test";

function overviewScore(lines = 42, length = 18, lyrics = false) {
  return {
    version: 1,
    id: "overview-browser",
    title: "一屏看全验收",
    key: "C",
    bpm: 240,
    notes: Array.from({ length: lines }, (_, row) => [
      ...(row ? [{ type: "break" }] : []),
      ...Array.from({ length }, (_, index) => ({
        type: "note",
        degree: index % 12 === 11 ? 0 : ((row + index) % 7) + 1,
        duration: [0.25, 0.5, 1, 2][index % 4],
        octave: (index % 5) - 2,
        sharp: index % 4 === 0,
        ...(row % 7 === 0 ? { repeat: 2 } : {}),
      })),
    ]).flat(),
    ...(lyrics
      ? {
          lyrics: Array.from(
            { length: lines },
            (_, row) => `第${row + 1}句歌词，和音符一起看全。`,
          ),
        }
      : {}),
  };
}

async function load(page, score) {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  if (page.viewportSize().width <= 768)
    await page.locator(".menu-toggle").click();
  await page.locator("#import-open").click();
  await page.locator("#import-text").fill(JSON.stringify(score));
  await page.getByRole("button", { name: "新建为可编辑草稿" }).click();
  await page.locator("#voice").selectOption("synth");
  await page.locator("#practice-mode").click();
  await page.locator("#practice-overview").click();
  await expect(page.locator("#score")).toHaveAttribute(
    "data-overview-columns",
    /[1-4]/,
  );
}

async function bounds(page) {
  return page.locator("#score").evaluate((root) => {
    const viewport = root.getBoundingClientRect();
    const inside = (node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.left >= viewport.left - 1 &&
        rect.right <= viewport.right + 1 &&
        rect.top >= viewport.top - 1 &&
        rect.bottom <= viewport.bottom + 1
      );
    };
    return {
      allInside: [
        ...root.querySelectorAll(".note, .line-number, .row-repeat-mark"),
      ].every(inside),
      overflowX: root.scrollWidth - root.clientWidth,
      overflowY: root.scrollHeight - root.clientHeight,
      scrollTop: root.scrollTop,
      documentWidth: document.documentElement.scrollWidth,
      width: innerWidth,
      rows: [...root.querySelectorAll(".phrase")].map((row) =>
        Number(row.dataset.start),
      ),
    };
  });
}

async function expectWholeScore(page) {
  await expect.poll(async () => (await bounds(page)).allInside).toBe(true);
  const result = await bounds(page);
  expect(result.overflowX).toBeLessThanOrEqual(1);
  expect(result.overflowY).toBeLessThanOrEqual(1);
  expect(result.scrollTop).toBe(0);
  expect(result.documentWidth).toBeLessThanOrEqual(result.width);
  expect(result.rows).toEqual([...result.rows].sort((a, b) => a - b));
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 568 },
  { width: 800, height: 450 },
]) {
  test(`长谱一屏看全：${viewport.width}px 所有音符与行号可见，先左后右且不溢出`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const score = overviewScore(42, 18, true);
    await load(page, score);
    await expect(page.locator(".note")).toHaveCount(42 * 18);
    await expect(page.locator(".phrase")).toHaveCount(42);
    await expectWholeScore(page);
    if (viewport.width > 768)
      expect(
        Number(
          await page.locator("#score").getAttribute("data-overview-columns"),
        ),
      ).toBeGreaterThanOrEqual(2);
    for (const theme of ["ink", "forest", "dark"]) {
      await page.evaluate(
        (theme) => (document.body.dataset.theme = theme),
        theme,
      );
      await expectWholeScore(page);
      await page.screenshot({
        path: `work/overview-${viewport.width}-${theme}.png`,
      });
    }
    await expect(page.locator("#practice-overview")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
}

test("总览播放第二列时保持整首不滚动，点击定位、高亮、暂停与窗口缩放仍可用", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await load(page, overviewScore());
  const note = page.locator(".overview-column").nth(1).locator(".note").first();
  const index = await note.getAttribute("data-index");
  await note.click();
  await page.locator("#play").click();
  await expect(
    page.locator(`.note.playing[data-index="${index}"]`),
  ).toBeVisible();
  await expect(
    page.locator(".overview-column").nth(1).locator(".phrase.current"),
  ).toHaveCount(1);
  await expectWholeScore(page);
  await page.setViewportSize({ width: 1180, height: 680 });
  await expectWholeScore(page);
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  await expect(page.locator(".note.playing")).toHaveCount(1);
  await expectWholeScore(page);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect(errors).toEqual([]);
});

test("总览开关、切回写谱与重新进入保留原谱及字号偏好，歌词开关会重新适配", async ({
  page,
  request,
}) => {
  await load(page, overviewScore(26, 14, true));
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  const before = (await (await request.get("/api/scores")).json()).find(
    (item) => item.title === "一屏看全验收",
  );
  const sizes = await page
    .locator(".note")
    .evaluateAll((nodes) => nodes.map((node) => node.style.fontSize));
  await page.locator("#lyrics-toggle").click();
  await expectWholeScore(page);
  await page.locator("#lyrics-toggle").click();
  await expectWholeScore(page);
  await page.locator("#practice-overview").click();
  await expect(page.locator(".overview-page")).toHaveCount(0);
  await expect(page.locator("body")).not.toHaveClass(/practice-overview/);
  expect(
    await page
      .locator(".note")
      .evaluateAll((nodes) => nodes.map((node) => node.style.fontSize)),
  ).toEqual(sizes);
  await page.locator("#practice-overview").click();
  await expectWholeScore(page);
  await page.locator("#edit-mode").click();
  await expect(page.locator("#practice-overview")).not.toBeVisible();
  await expect(page.locator(".overview-page")).toHaveCount(0);
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  await page.locator("#practice-mode").click();
  await expectWholeScore(page);
  await page.reload();
  await page.locator("#practice-mode").click();
  await expect(page.locator("#practice-overview")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expectWholeScore(page);
  const after = (await (await request.get("/api/scores")).json()).find(
    (item) => item.id === before.id,
  );
  expect(after).toEqual(before);
  expect(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("harmonica.preferences.v1")).zoom,
    ),
  ).toBe(100);
});

test("短谱保留单列原字号，单句超长谱也完整换行缩放", async ({ page }) => {
  await load(page, overviewScore(1, 4));
  await expect(page.locator("#score")).toHaveAttribute(
    "data-overview-columns",
    "1",
  );
  await expect(page.locator("#score")).toHaveAttribute(
    "data-overview-scale",
    "1",
  );
  await expectWholeScore(page);
  await page.locator("#edit-mode").click();
  await page.locator("#import-open").click();
  await page
    .locator("#import-text")
    .fill(JSON.stringify(overviewScore(1, 250)));
  await page.getByRole("button", { name: "新建为可编辑草稿" }).click();
  await page.locator("#practice-mode").click();
  await expect(page.locator(".note")).toHaveCount(250);
  await expectWholeScore(page);
});
