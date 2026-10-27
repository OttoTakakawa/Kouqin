import { test, expect } from "@playwright/test";
const source = {
  version: 1, id: "legacy-review", title: "旧草稿核对", key: "C", bpm: 90,
  notes: [{ type: "note", degree: 3, octave: 0, sharp: false, duration: 1 }],
  lyrics: ["磁盘上的原歌词"],
};
test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/scores")).json())
    await request.delete("/api/scores/" + s.id);
  expect((await request.post("/api/scores", { data: source })).ok()).toBeTruthy();
});
async function legacy(page) {
  await page.goto("/");
  await page.evaluate(s => localStorage.setItem("harmonica.draft.v1", JSON.stringify({
    score: { ...s, notes: s.notes.map(n => ({ ...n, repeat: 2 })), title: "当前旧草稿", lyrics: ["刚刚改好的歌词"] }, dirty: true, savedAt: Date.now(),
  })), source);
  await page.reload();
  await expect(page.locator("#title")).toHaveValue("当前旧草稿");
  await page.locator("#save").click();
  await expect(page.locator("#save-review-dialog")).toBeVisible();
}

test("完全没有原保存时间的旧稿才需核对，不提前写盘；后续保存正常", async ({ page, request }) => {
  let writes = 0;
  page.on("request", r => { if (r.method() === "POST" && r.url().endsWith("/api/scores")) writes++; });
  await legacy(page);
  await expect(page.locator("#save-review-disk")).toContainText("磁盘上的原歌词");
  await expect(page.locator("#save-review-current")).toContainText("刚刚改好的歌词");
  await expect(page.locator("#save-review-current")).toContainText("×2");
  await expect(page.locator("#save-review-disk")).not.toContainText("×2");
  expect(writes).toBe(1); // 自动兼容尝试返回428，磁盘未写入。
  expect((await (await request.get("/api/scores")).json())[0].lyrics).toEqual(source.lyrics);
  await page.locator("#save-review-dialog").evaluate(n => Promise.all(n.getAnimations().map(a => a.finished)));
  for (const theme of ["ink", "forest", "dark"]) {
    await page.evaluate(t => { document.body.dataset.theme = t; }, theme);
    await page.screenshot({ path: `work/legacy-save-${theme}.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "work/legacy-save-mobile.png" });
  expect(await page.locator("#save-review-dialog").evaluate(n => n.scrollWidth <= n.clientWidth)).toBeTruthy();
  await page.locator("#save-review-confirm").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  await expect(page.locator("#save-review-dialog")).not.toBeVisible();
  expect(writes).toBe(2);
  let scores = await (await request.get("/api/scores")).json();
  expect(scores).toHaveLength(1);
  expect(scores[0].id).toBe(source.id);
  expect(scores[0].lyrics).toEqual(["刚刚改好的歌词"]);
  await page.locator("#title").fill("之后直接保存");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  await expect(page.locator("#save-review-dialog")).not.toBeVisible();
  scores = await (await request.get("/api/scores")).json();
  expect(scores[0].title).toBe("之后直接保存");
});

test("取消核对不写盘；核对期间磁盘再变更仍拒绝覆盖", async ({ page, request }) => {
  await legacy(page);
  await page.locator("#save-review-dialog").getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator("#save-state")).toContainText("未保存");
  expect((await (await request.get("/api/scores")).json())[0].title).toBe(source.title);
  await page.locator("#save").click();
  await expect(page.locator("#save-review-dialog")).toBeVisible();
  const disk = (await (await request.get("/api/scores")).json())[0];
  await request.post("/api/scores", { data: { ...disk, title: "其他页面的新改动" } });
  await page.locator("#save-review-confirm").click();
  await expect(page.locator("#save-review-error")).toContainText("已拒绝覆盖");
  expect((await (await request.get("/api/scores")).json())[0].title).toBe("其他页面的新改动");
  await expect(page.locator("#save-state")).toContainText("未保存");
  await page.locator("#save-review-dialog").getByRole("button", { name: "取消", exact: true }).click();
  await page.reload();
  await expect(page.locator("#title")).toHaveValue("当前旧草稿");
});

test("有原保存时间的旧草稿直接保存回原ID，无导出刷新核对步骤", async ({ page, request }) => {
  const disk = (await (await request.get("/api/scores")).json())[0];
  delete disk.revision;
  await page.goto("/");
  await page.evaluate(s => localStorage.setItem("harmonica.draft.v1", JSON.stringify({
    score: { ...s, title: "旧稿一键保存", lyrics: ["旧稿保留的歌词"] }, dirty: true, savedAt: Date.now(),
  })), disk);
  await page.reload(); // 测试准备：模拟启动时自动恢复旧稿。
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  await expect(page.locator("#save-review-dialog")).not.toBeVisible();
  const saved = await (await request.get("/api/scores")).json();
  expect(saved).toHaveLength(1);
  expect(saved[0].id).toBe(source.id);
  expect(saved[0].title).toBe("旧稿一键保存");
  expect(saved[0].lyrics).toEqual(["旧稿保留的歌词"]);
});

test("旧稿时间仍在但磁盘已更新，自动兼容拒绝覆盖并保留草稿", async ({ page, request }) => {
  const disk = (await (await request.get("/api/scores")).json())[0];
  const { revision, ...old } = disk;
  await request.post("/api/scores", { data: { ...disk, title: "磁盘后来保存的版本" } });
  await page.goto("/");
  await page.evaluate(s => localStorage.setItem("harmonica.draft.v1", JSON.stringify({
    score: { ...s, title: "过期旧稿" }, dirty: true, savedAt: Date.now(),
  })), old);
  await page.reload();
  await page.locator("#save").click();
  await expect(page.locator("#message")).toContainText("已拒绝覆盖");
  await expect(page.locator("#save-state")).toContainText("未保存");
  expect((await (await request.get("/api/scores")).json())[0].title).toBe("磁盘后来保存的版本");
});
