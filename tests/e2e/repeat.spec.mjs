import { test, expect } from "@playwright/test";
const note = degree => ({type:"note",degree,duration:1,octave:0,sharp:false});
async function load(page) {
  await page.goto("/");
  await page.locator("#import-open").click();
  await page.locator("#import-text").fill(JSON.stringify({version:1,id:"repeat-browser",title:"行重复验收",key:"C",bpm:120,notes:[note(1),note(2),{type:"break"},note(5)]}));
  page.once("dialog", d=>d.accept());
  await page.getByRole("button", {name:"新建为可编辑草稿"}).click();
  await page.locator("#voice").selectOption("synth");
}
async function selectRow(page, row) {
  await page.locator("#score .phrase").nth(row - 1).locator(".note").first().click();
}
async function setRepeat(page, row, count) {
  await selectRow(page, row);
  await page.locator("#repeat-menu > summary").click();
  await page.locator(`#repeat-menu [data-repeat="${count}"]`).click();
}
const marker = (page, row) =>
  page.locator("#score .phrase").nth(row - 1).locator(".row-repeat-mark");

test("逐行重复由底栏设置，可撤销、取消、保存重读，真实播放按次数回到行首", async ({page,request}) => {
  await load(page);
  await setRepeat(page, 1, 2);
  await expect(page.locator("#repeat-menu > summary")).toHaveText("重复 ×2");
  await expect(marker(page, 1)).toHaveText("×2");
  await expect(marker(page, 2)).toHaveCount(0);
  await page.locator("#score").press("Control+z");
  await expect(marker(page, 1)).toHaveCount(0);
  await expect(page.locator("#repeat-menu > summary")).toHaveText("重复");
  await setRepeat(page, 1, 3);
  await expect(marker(page, 1)).toHaveText("×3");
  await page.reload();
  await expect(marker(page, 1)).toHaveText("×3");
  await setRepeat(page, 1, 1);
  await expect(marker(page, 1)).toHaveCount(0);
  await setRepeat(page, 1, 2);
  await expect(marker(page, 1)).toHaveText("×2");
  await page.locator("#save").click();
  await expect(page.locator("#save-state")).toHaveText("已保存到本地");
  const saved = (await (await request.get("/api/scores")).json()).find(s=>s.title==="行重复验收");
  expect(saved.notes).toHaveLength(4);
  expect(saved.notes[0].repeat).toBe(2);
  expect(saved.notes[1].repeat).toBe(2);
  expect(saved.notes[3].repeat).toBeUndefined();
  await page.reload();
  await expect(marker(page, 1)).toHaveText("×2");
  await page.locator("#practice-mode").click();
  await expect(marker(page, 1)).toHaveText("×2");
  await page.locator('#score .note[data-index="0"]').click();
  await page.evaluate(()=>{
    window.repeatPlayed=[];
    let previous;
    const record=()=>{const n=document.querySelector('.note.playing')?.dataset.index;
      if(n!==undefined && n!==previous) window.repeatPlayed.push(Number(n)); previous=n;};
    window.repeatWatcher=new MutationObserver(record);
    window.repeatWatcher.observe(document.querySelector('#score'),{subtree:true,attributes:true,attributeFilter:['class']});
  });
  await page.locator("#play").click();
  await expect.poll(()=>page.evaluate(()=>window.repeatPlayed),{timeout:8000}).toEqual([0,1,0,1,3]);
  await page.locator("#stop").click();
  await page.evaluate(()=>window.repeatWatcher.disconnect());
});

test("重复标记三主题、练习和窄屏显示且不撑宽页面，行内不再有重复下拉", async ({page}) => {
  await load(page);
  await setRepeat(page, 1, 3);
  await expect(page.locator("#score select.row-repeat")).toHaveCount(0);
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    for(const theme of ["ink","forest","dark"]) {
      await page.evaluate(t=>document.body.dataset.theme=t,theme);
      await expect(page.locator("#repeat-menu > summary")).toBeVisible();
      await expect(marker(page, 1)).toHaveText("×3");
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({path:`work/repeat-${theme}-${width}-edit.png`});
      await page.locator("#practice-mode").click();
      await expect(marker(page, 1)).toHaveText("×3");
      await page.screenshot({path:`work/repeat-${theme}-${width}-practice.png`});
      await page.locator("#edit-mode").click();
      await selectRow(page, 1);
    }
  }
});
