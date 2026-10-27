import { test, expect } from "@playwright/test";

test("打开写谱台不下载音色，选音色不提前加载，播放时只加载选中的一套", async ({
  page,
}) => {
  const audioRequests = [];
  page.on("request", (request) => {
    if (/\/audio\/.*-mp3\.js/.test(request.url()))
      audioRequests.push(new URL(request.url()).pathname);
  });
  await page.goto("/");
  await expect(page.locator("#score")).toBeVisible();
  expect(audioRequests).toEqual([]);
  const bundle = await page.request.get("/app.js");
  expect((await bundle.body()).byteLength).toBeLessThan(500000);
  await page.locator("#new-score").click();
  await page.locator("#score").click();
  await page.keyboard.type("123");
  await page.locator("#voice").selectOption("synth");
  await page.locator("#play").click();
  await expect(page.locator(".note.playing")).toHaveCount(1);
  expect(audioRequests).toEqual([]);
  await page.locator("#stop").click();
  await page.locator("#voice").selectOption("musyngkite");
  expect(audioRequests).toEqual([]);
  await page.locator("#play").click();
  await expect(page.locator(".note.playing")).toHaveCount(1);
  expect(audioRequests).toEqual(["/audio/musyngkite-harmonica-mp3.js"]);
});
