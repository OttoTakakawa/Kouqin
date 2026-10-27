import { test, expect } from "@playwright/test";

async function setup(page, notation = "34564\n12345") {
  await page.goto("/");
  await page.locator("#import-open").click();
  await page.locator("#import-text").fill(notation);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "新建为可编辑草稿" }).click();
}

test("从音符前的空白拖至行尾，形成真实选区而非浏览器文字高亮", async ({ page }) => {
  await setup(page);
  const first = await page.locator('.note[data-index="0"]').boundingBox();
  const last = await page.locator('.note[data-index="4"]').boundingBox();
  await page.mouse.move(first.x - 6, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width + 6, last.y + last.height / 2, { steps: 18 });
  await page.mouse.up();
  await expect(page.locator(".note.chosen")).toHaveText(["3", "4", "5", "6", "4"]);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await page.screenshot({ path: "work/drag-selection-fixed.png" });
  await page.locator("#score").press("Delete");
  await expect(page.locator(".note")).toHaveText(["1", "2", "3", "4", "5"]);
  await page.locator("#score").press("Control+z");
  await expect(page.locator(".note")).toHaveText(["3", "4", "5", "6", "4", "1", "2", "3", "4", "5"]);
});

test("从第二行空白反向跨行拖选，松手后复制的是完整音符选区", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await setup(page);
  const first = await page.locator('.note[data-index="0"]').boundingBox();
  const last = await page.locator('.note[data-index="10"]').boundingBox();
  await page.mouse.move(last.x + last.width + 16, last.y + last.height / 2);
  await page.mouse.down();
  await page.mouse.move(first.x - 6, first.y + first.height / 2, { steps: 24 });
  await page.mouse.up();
  await expect(page.locator(".note.chosen")).toHaveCount(10);
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("34564\n12345");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  // 下一次普通点击必须正常收回拖选范围。
  await page.locator('.note[data-index="2"]').click();
  await expect(page.locator(".note.chosen")).toHaveText(["5"]);
});

test("窄屏同一句折行后仍能从空白拖选，松绿主题选区可见", async ({ page }) => {
  await setup(page, "34564123456712");
  await page.setViewportSize({ width: 390, height: 844 });
  const first = await page.locator('.note[data-index="0"]').boundingBox();
  const last = await page.locator('.note[data-index="13"]').boundingBox();
  expect(last.y).toBeGreaterThan(first.y);
  await page.evaluate(() => { document.body.dataset.theme = "forest"; });
  await page.mouse.move(first.x - 6, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width + 6, last.y + last.height / 2, { steps: 16 });
  await page.mouse.up();
  await expect(page.locator(".note.chosen")).toHaveCount(14);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "work/drag-selection-forest-mobile.png" });
});

test("从谱面外侧留白开始拖动也能选中音符", async ({ page }) => {
  await setup(page);
  const root = await page.locator("#score").boundingBox();
  const first = await page.locator('.note[data-index="0"]').boundingBox();
  const third = await page.locator('.note[data-index="2"]').boundingBox();
  await page.mouse.move(root.x + 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(third.x + third.width / 2, third.y + third.height / 2, { steps: 18 });
  await page.mouse.up();
  await expect(page.locator(".note.chosen")).toHaveText(["3", "4", "5"]);
});
