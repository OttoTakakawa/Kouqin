import { test, expect } from "@playwright/test";

const sample = (id, title) => ({
  version: 1, id, title, key: "C", bpm: 90,
  notes: [{ type: "note", degree: 1, octave: 0, sharp: false, duration: 1 }],
});
const draftEntries = (page) => page.evaluate(() => Object.fromEntries(
  Object.entries(localStorage).filter(([key]) => key.startsWith("harmonica.draft.")),
));
async function seed(request) {
  for (const s of await (await request.get("/api/scores")).json())
    await request.delete("/api/scores/" + s.id);
  for (const s of [sample("protect-a", "保护甲"), sample("protect-b", "保护乙")])
    expect((await request.post("/api/scores", { data: s })).ok()).toBeTruthy();
}
async function open(page) {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await expect(page.locator("#score")).toBeVisible();
}
async function choose(page, title) {
  await page.locator("#search").fill(title);
  await page.locator(".song").filter({ hasText: title }).click();
  await page.locator("#search").fill("");
}
test.beforeEach(async ({ request }) => seed(request));

test("两首独立草稿：切歌、刷新、再打开及保存一首不丢另一首", async ({ page, request }) => {
  await open(page);
  await choose(page, "保护甲");
  await page.locator("#title").fill("甲未保存");
  await choose(page, "保护乙");
  await page.locator("#title").fill("乙未保存");
  expect(Object.keys(await draftEntries(page))).toHaveLength(2);
  await page.reload();
  await expect(page.locator("#title")).toHaveValue("乙未保存");
  await choose(page, "保护甲");
  await expect(page.locator("#title")).toHaveValue("甲未保存");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  await choose(page, "保护乙");
  await expect(page.locator("#title")).toHaveValue("乙未保存");
  const disk = await (await request.get("/api/scores")).json();
  expect(disk.find((s) => s.id === "protect-a").title).toBe("甲未保存");
  expect(disk.find((s) => s.id === "protect-b").title).toBe("保护乙");
});

test("读取失败保留所有草稿原文，能恢复并继续编辑，重连后可保存", async ({ page }) => {
  await open(page);
  await choose(page, "保护甲");
  await page.locator("#title").fill("断连前甲");
  const before = await draftEntries(page);
  await page.route("**/api/scores", (route) => route.fulfill({
    status: 503, contentType: "application/json", body: '{"error":"隔离测试断连"}',
  }));
  await page.reload();
  await expect(page.locator("#message")).toContainText("读取乐谱库失败");
  await expect(page.locator("#title")).toHaveValue("断连前甲");
  expect(await draftEntries(page)).toEqual(before);
  await page.locator("#title").fill("断连后甲");
  await page.unroute("**/api/scores");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
});

test("旧版草稿迁移；读取失败与损坏草稿均不清空原文", async ({ page }) => {
  await open(page);
  const legacy = JSON.stringify({ score: sample("protect-a", "旧草稿"), dirty: true, savedAt: 1 });
  await page.evaluate((raw) => {
    localStorage.setItem("harmonica.draft.v1", raw);
    localStorage.setItem("harmonica.draft.v2.broken", "损坏原文");
  }, legacy);
  await page.route("**/api/scores", (route) => route.abort());
  await page.reload();
  await expect(page.locator("#title")).toHaveValue("旧草稿");
  expect(await draftEntries(page)).toEqual({
    "harmonica.draft.v1": legacy, "harmonica.draft.v2.broken": "损坏原文",
  });
  await page.unroute("**/api/scores");
  await page.reload();
  await expect(page.locator("#title")).toHaveValue("旧草稿");
  const entries = await draftEntries(page);
  expect(entries["harmonica.draft.v1"]).toBeUndefined();
  expect(entries["harmonica.draft.v2.broken"]).toBe("损坏原文");
  await page.locator("#save").click();
  await expect(page.locator("#message")).toContainText("缺少保存版本");
});

test("两个标签页保存冲突拒绝覆盖，保留双方草稿且允许导出", async ({ page, context, request }) => {
  await open(page);
  await choose(page, "保护甲");
  const other = await context.newPage();
  await open(other);
  await choose(other, "保护甲");
  await page.locator("#title").fill("甲新版");
  await other.locator("#title").fill("甲旧页编辑");
  expect(Object.keys(await draftEntries(page))).toHaveLength(2);
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  await other.locator("#save").click();
  await expect(other.locator("#message")).toContainText("已拒绝覆盖");
  await expect(other.locator("#save-state")).toContainText("未保存");
  const disk = await (await request.get("/api/scores")).json();
  expect(disk.find((s) => s.id === "protect-a").title).toBe("甲新版");
  const drafts = Object.values(await draftEntries(other)).map(JSON.parse);
  expect(drafts.some((d) => d.score.title === "甲旧页编辑")).toBeTruthy();
  const download = other.waitForEvent("download");
  await other.locator("#export").click();
  expect((await download).suggestedFilename()).toBe("甲旧页编辑.json");
  await other.reload();
  await expect(other.locator("#title")).toHaveValue("甲旧页编辑");
  await other.locator("#save").click();
  await expect(other.locator("#message")).toContainText("已拒绝覆盖");
});

test("新建未保存乐谱切走后有恢复入口；保存后撤销可再次保存", async ({ page }) => {
  await open(page);
  await page.locator("#new-score").click();
  await page.locator("#title").fill("独立新草稿");
  await choose(page, "保护甲");
  await choose(page, "独立新草稿");
  await expect(page.locator("#title")).toHaveValue("独立新草稿");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  await page.locator("#title").fill("保存后改名");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  await page.locator("#score").press("Control+z");
  await expect(page.locator("#title")).toHaveValue("独立新草稿");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
});

test("新页面恢复草稿保留来源页面副本，刷新优先恢复本页面编辑", async ({ page, context }) => {
  await open(page);
  await choose(page, "保护甲");
  await page.locator("#title").fill("来源页面草稿");
  const source = await draftEntries(page);
  const other = await context.newPage();
  await open(other);
  await expect(other.locator("#title")).toHaveValue("来源页面草稿");
  await other.locator("#title").fill("第二页面草稿");
  const entries = await draftEntries(other);
  for (const [key, raw] of Object.entries(source)) expect(entries[key]).toBe(raw);
  await page.reload();
  await expect(page.locator("#title")).toHaveValue("来源页面草稿");
  await other.reload();
  await expect(other.locator("#title")).toHaveValue("第二页面草稿");
});
