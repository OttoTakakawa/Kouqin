import { test, expect } from "@playwright/test";

const note = (degree, duration = 1, performance) => ({
  type: "note",
  degree,
  duration,
  octave: 0,
  sharp: false,
  ...(performance ? { performance } : {}),
});
const sample = {
  version: 1,
  id: "performance-browser",
  title: "副歌演出验收",
  key: "C",
  bpm: 120,
  notes: [note(1, 2), note(3, 2), { type: "break" }, note(5, 2), note(6, 2)],
};

async function load(page, score = sample) {
  await page.goto("/");
  await page.locator("#import-open").click();
  await page.locator("#import-text").fill(JSON.stringify(score));
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "新建为可编辑草稿" }).click();
  await page.locator("#voice").selectOption("synth");
}

test("段落演出取消不改谱；副歌随乐谱保存重读和撤销，并参与真实播放", async ({
  page,
  request,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await load(page);
  await page.locator("#performance-open").click();
  await page.getByLabel("第 2 句演出").selectOption("chorus");
  await page
    .locator("#performance-dialog")
    .getByRole("button", { name: "取消" })
    .click();
  await page.locator("#performance-open").click();
  await expect(page.getByLabel("第 2 句演出")).toHaveValue("");
  await page.getByLabel("第 1 句演出").selectOption("calm");
  await page.getByLabel("第 2 句演出").selectOption("chorus");
  await page.getByRole("button", { name: "应用演出" }).click();
  await page.locator("#score").press("Control+z");
  await page.locator("#performance-open").click();
  await expect(page.getByLabel("第 2 句演出")).toHaveValue("");
  await page.getByLabel("第 1 句演出").selectOption("calm");
  await page.getByLabel("第 2 句演出").selectOption("chorus");
  await page.getByRole("button", { name: "应用演出" }).click();
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  const items = await (await request.get("/api/scores")).json();
  const saved = items.find((item) => item.title === sample.title);
  expect(saved.notes[0].performance).toBe("calm");
  expect(saved.notes[3].performance).toBe("chorus");
  expect(saved.notes[3].duration).toBe(2);
  await page.reload();
  await page.locator("#performance-open").click();
  await expect(page.getByLabel("第 2 句演出")).toHaveValue("chorus");
  await page
    .locator("#performance-dialog")
    .getByRole("button", { name: "取消" })
    .click();
  await page.locator("#practice-mode").click();
  await page.locator('.note[data-index="3"]').click();
  await page.locator("#play").click();
  await expect(page.locator("body")).toHaveAttribute(
    "data-performance",
    "chorus",
  );
  await expect(page.locator("#performance-stage")).toBeVisible();
  await expect(page.locator(".phrase.current .note.playing")).toHaveCount(1);
  await expect(page.locator(".playhead")).toHaveCount(0);
  await page.locator("#play").click();
  await expect(page.locator("#performance-stage")).not.toBeVisible();
  await expect(page.locator(".note.playing")).toHaveCount(1);
  await page.locator("#play").click();
  await expect(page.locator("#performance-stage")).toBeVisible();
  await page.locator("#effects").uncheck();
  await expect(page.locator("#performance-stage")).not.toBeVisible();
  await expect(page.locator(".note.playing")).toHaveCount(1);
  await page.locator("#effects").check();
  await expect(page.locator("#performance-stage")).toBeVisible();
  await page.locator("#stop").click();
  await expect(page.locator("body")).not.toHaveClass(/stage-active/);
  expect(errors).toEqual([]);
});

test("三主题手机播放不溢出；副歌循环重入、切回写谱和减少动态效果都能清场", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const score = structuredClone(sample);
  score.notes = [note(5, 0.5, "chorus"), note(6, 0.5, "chorus")];
  await load(page, score);
  await page.locator("#practice-mode").click();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["ink", "forest", "dark"]) {
    await page.evaluate((theme) => {
      document.body.dataset.theme = theme;
    }, theme);
    await page.locator("#loop-phrase").click();
    await expect(page.locator("body")).toHaveAttribute(
      "data-performance",
      "chorus",
    );
    await expect(page.locator("#performance-stage")).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.locator("body")).toHaveClass(/stage-active/);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await page.locator("#loop-phrase").click();
  }
  await page.locator("#play").click();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("#performance-stage")).not.toBeVisible();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator("#stop").click();
  await page.locator("#play").click();
  await expect(page.locator("#performance-stage")).toBeVisible();
  await page.locator("#edit-mode").click();
  await expect(page.locator("#performance-stage")).not.toBeVisible();
  await page.locator(".menu-toggle").click();
  await page.locator("#import-open").click();
  await expect(page.locator("#import-dialog")).toBeVisible();
  expect(errors).toEqual([]);
});
