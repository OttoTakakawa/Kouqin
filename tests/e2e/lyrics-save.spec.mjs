import { test, expect } from "@playwright/test";

const note = (degree, duration = 1) => ({ type: "note", degree, octave: 0, sharp: false, duration });
const sample = {
  version: 1, id: "lyrics-save-source", title: "歌词对照验收", key: "C", bpm: 90,
  notes: [note(3), note(4, .5), note(5, 2), note(0), { type: "break" }, note(6), note(4)],
  lyrics: ["第一句原歌词", "第二句原歌词"],
};

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/scores")).json())
    await request.delete("/api/scores/" + s.id);
  expect((await request.post("/api/scores", { data: sample })).ok()).toBeTruthy();
});
async function open(page) {
  page.on("dialog", d => d.accept());
  await page.goto("/");
  await page.locator("#search").fill(sample.title);
  await page.locator(".song").filter({ hasText: sample.title }).click();
}

test("左右歌词逐行对齐、定位当前句，应用后保存落盘并重读", async ({ page, request }) => {
  await open(page);
  await page.locator('.note[data-index="5"]').click();
  await page.locator("#lyrics-open").click();
  await expect(page.getByLabel("第 2 句歌词", { exact: true })).toBeFocused();
  await page.locator("#lyrics-dialog").evaluate(n => Promise.all(n.getAnimations().map(a => a.finished)));
  await expect(page.locator(".lyrics-row")).toHaveCount(2);
  await expect(page.locator(".lyrics-row").first().locator(".lyrics-note")).toHaveText(["3", "4", "5", "停"]);
  for (const row of await page.locator(".lyrics-row").all()) {
    const left = await row.locator(".lyrics-score").boundingBox();
    const right = await row.locator("textarea").boundingBox();
    expect(left.x + left.width).toBeLessThan(right.x);
    expect(Math.abs(left.y + left.height / 2 - right.y - right.height / 2)).toBeLessThan(2);
  }
  await page.getByLabel("第 1 句歌词", { exact: true }).fill("改好的第一句");
  await page.getByRole("button", { name: "应用歌词", exact: true }).click();
  await expect(page.locator("#toast")).toContainText("请保存乐谱");
  await expect(page.locator("#save-state")).toContainText("未保存");
  expect((await (await request.get("/api/scores")).json())[0].lyrics).toEqual(sample.lyrics);
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  const saved = (await (await request.get("/api/scores")).json())[0];
  expect(saved.lyrics).toEqual(["改好的第一句", "第二句原歌词"]);
  expect(saved.revision).toMatch(/^[a-f0-9]{64}$/);
  await page.reload();
  await page.locator("#lyrics-open").click();
  await expect(page.getByLabel("第 1 句歌词", { exact: true })).toHaveValue("改好的第一句");
  await page.getByLabel("第 1 句歌词", { exact: true }).fill("取消的内容");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.locator("#lyrics-open").click();
  await expect(page.getByLabel("第 1 句歌词", { exact: true })).toHaveValue("改好的第一句");
});

test("三主题与窄屏左右对照不溢出，长句共用行高", async ({ page, request }) => {
  const source = (await (await request.get("/api/scores")).json())[0];
  await request.post("/api/scores", { data: { ...source,
    notes: [...Array.from({ length: 30 }, (_, i) => note(i % 7 + 1)), { type: "break" }, note(6), note(4)],
    lyrics: ["这是一句较长的歌词需要折行显示并和左边的数字谱保持在同一行中".repeat(3), "第二句"],
  } });
  await open(page);
  await page.locator("#lyrics-open").click();
  for (const theme of ["ink", "forest", "dark"]) {
    await page.evaluate(t => { document.body.dataset.theme = t; }, theme);
    await page.screenshot({ path: `work/lyrics-${theme}-desktop.png` });
  }
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const row = page.locator(".lyrics-row").first();
    const a = await row.locator(".lyrics-score").boundingBox();
    const b = await row.locator("textarea").boundingBox();
    expect(a.x + a.width).toBeLessThan(b.x);
    const bounds = await page.locator("#lyrics-dialog").boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(await page.locator("#lyrics-dialog").evaluate(n => n.scrollWidth <= n.clientWidth)).toBeTruthy();
    const lyric = page.getByLabel("第 1 句歌词", { exact: true });
    expect(await lyric.evaluate(n => n.scrollHeight <= n.clientHeight + 1)).toBeTruthy();
    await page.screenshot({ path: `work/lyrics-dark-${width}.png` });
  }
});

test("旧草稿无版本时另存副本成功，原JSON完整保留，之后可以继续保存", async ({ page, request }) => {
  await open(page);
  await page.evaluate(s => localStorage.setItem("harmonica.draft.v1", JSON.stringify({
    score: { ...s, title: "旧草稿修改", lyrics: ["未保存歌词", "保留的第二句"] }, dirty: true, savedAt: Date.now(),
  })), sample);
  await page.reload();
  await expect(page.locator("#title")).toHaveValue("旧草稿修改");
  await page.locator("#save").click();
  await expect(page.locator("#message")).toContainText("另存副本");
  await page.locator("#save-review-copy").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  const scores = await (await request.get("/api/scores")).json();
  expect(scores).toHaveLength(2);
  const original = scores.find(s => s.id === sample.id);
  expect(original.title).toBe(sample.title);
  expect(original.notes).toEqual(sample.notes);
  expect(original.lyrics).toEqual(sample.lyrics);
  const copy = scores.find(s => s.id !== sample.id);
  expect(copy.title).toBe("旧草稿修改（副本）");
  expect(copy.lyrics).toEqual(["未保存歌词", "保留的第二句"]);
  await page.locator("#title").fill("副本再次修改");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  expect((await (await request.get("/api/scores")).json()).find(s => s.id === copy.id).title).toBe("副本再次修改");
});

test("少于原歌词的谱句保留多余歌词，不因应用而截断", async ({ page, request }) => {
  const s = (await (await request.get("/api/scores")).json())[0];
  await request.post("/api/scores", { data: { ...s, notes: [note(1)], lyrics: ["一句", "不能丢的旧词"] } });
  await open(page);
  await page.locator("#lyrics-open").click();
  await expect(page.locator(".lyrics-row")).toHaveCount(2);
  await expect(page.locator(".lyrics-row").nth(1)).toContainText("原歌词保留");
  await page.getByLabel("第 1 句歌词", { exact: true }).fill("修改一句");
  await page.getByRole("button", { name: "应用歌词", exact: true }).click();
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  expect((await (await request.get("/api/scores")).json())[0].lyrics).toEqual(["修改一句", "不能丢的旧词"]);
});
