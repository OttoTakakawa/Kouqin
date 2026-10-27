import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const windows = process.platform === "win32";
const powershell = path.join(process.env.SystemRoot || "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
async function run(script, args = [], env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], { env, windowsHide: true });
    let output = "";
    child.stdout.on("data", b => { output += b.toString("utf8"); });
    child.stderr.on("data", b => { output += b.toString("utf8"); });
    child.once("error", reject);
    child.once("exit", code => resolve({ code, output }));
  });
}
async function freePort() {
  const socket = net.createServer();
  // Windows可能分配到6667等浏览器禁止访问的端口；只从安全的高端口段取。
  try {
    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.listen(20000 + randomBytes(2).readUInt16BE() % 40000, "127.0.0.1", resolve);
    });
  } catch (error) {
    if (error.code === 'EADDRINUSE') return freePort();
    throw error;
  }
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function fixture(t, serverSource) {
  const work = path.resolve("work");
  await fs.mkdir(work, { recursive: true });
  const root = await fs.mkdtemp(path.join(work, "launcher 中文 空间-"));
  const launcher = path.join(root, "tools/webui-launcher"), data = path.join(root, "data/active"), desktop = path.join(root, "desktop");
  for (const dir of [launcher, data, desktop, path.join(root, "public"), path.join(root, "dist")]) await fs.mkdir(dir, { recursive: true });
  for (const file of ["start-harmonica.ps1", "install-launcher.ps1", "open-harmonica.cmd", "run-harmonica-no-browser.bat", "launch-from-protocol.bat", "launch-harmonica.html", "launch-harmonica.js"])
    await fs.copyFile(path.resolve("tools/webui-launcher", file), path.join(launcher, file));
  await fs.writeFile(path.join(root, "public/model.mjs"), "export {};\n");
  await fs.writeFile(path.join(root, "public/index.html"), "<title>Harmonica fixture</title>");
  await fs.copyFile('public/favicon.svg', path.join(root, 'public/favicon.svg'));
  const port = await freePort();
  await fs.writeFile(path.join(launcher, "launcher.json"), JSON.stringify({ port, data }));
  const source = serverSource || `
    import http from 'node:http';
    http.createServer((req,res)=>{
      if(req.url==='/api/health') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,app:'harmonica-studio',version:1,dataDirectory:process.env.HARMONICA_DATA,pid:process.pid}));}
      else res.end(req.url==='/app.js'?'console.log("ready")':'<title>Harmonica fixture</title>');
    }).listen(Number(process.env.PORT),'127.0.0.1');`;
  await fs.writeFile(path.join(root, "server.mjs"), `import {writeFileSync} from 'node:fs'; writeFileSync('fixture.pid',String(process.pid));\n${source}`);
  await fs.writeFile(path.join(root, "dist/app.js"), "console.log('built');\n");
  t.after(async () => {
    try { process.kill(Number(await fs.readFile(path.join(root, "fixture.pid"), "utf8"))); } catch (e) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
    assert.ok(path.resolve(root).startsWith(work + path.sep));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return {
    root, launcher, data, desktop, port,
    start: (args = [], env) => run(path.join(launcher, "start-harmonica.ps1"), ["-StartupTimeoutSeconds", "5", ...args], env),
    health: async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).json(),
    report: async id => {
      const text = await fs.readFile(path.join(launcher, 'logs', `status-${id}.js`), 'utf8');
      return JSON.parse(text.slice('window.harmonicaLaunchStatus('.length, -2));
    },
    logs: async () => {
      const dir = path.join(launcher, "logs");
      return Promise.all((await fs.readdir(dir)).filter(f => f.startsWith('launch-') && f.endsWith('.log')).map(async f => ({ file: f, text: await fs.readFile(path.join(dir, f), "utf8") })));
    },
  };
}

test("启动器：冷启动后才报就绪，重复启动复用进程，每次日志保留", { skip: !windows }, async t => {
  const f = await fixture(t);
  const first = await f.start();
  assert.equal(first.code, 0, first.output);
  assert.match(first.output, /服务和写谱台资源均已就绪/);
  const before = await f.health();
  const logs = await f.logs();
  const second = await f.start();
  assert.equal(second.code, 0, second.output);
  assert.match(second.output, /复用现有服务/);
  assert.equal((await f.health()).pid, before.pid);
  const after = await f.logs();
  assert.equal(after.length, 2);
  assert.equal(after.find(l => l.file === logs[0].file).text, logs[0].text);
});

async function bookmark(t, f, port = f.port, waitForProtocol = true) {
  // 这里只验证页面状态和回执；真实 Windows 协议交接必须另做可见浏览器验收。
  // 修改隔离副本的单一导航边界，避免测试触发本机个人曲库。
  const scriptPath = path.join(f.launcher, 'launch-harmonica.js');
  const source = await fs.readFile(scriptPath, 'utf8');
  const navigation = 'window.location.href = protocolLink.href;';
  assert.ok(source.includes(navigation), '协议导航边界已变化，请更新隔离测试');
  await fs.writeFile(scriptPath, source.replace(navigation,
    'window.protocolRequests.push(protocolLink.href); window.recordProtocol(protocolLink.href);'));
  const browser = await chromium.launch({ executablePath: process.env.HARMONICA_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const protocolRequests = [];
  await page.exposeFunction('recordProtocol', url => protocolRequests.push(url));
  await page.addInitScript(() => {
    window.protocolRequests = [];
  });
  await page.clock.install();
  await page.goto(pathToFileURL(path.join(f.launcher, 'launch-harmonica.html')).href + `?port=${port}&pin=1`);
  if (waitForProtocol && port >= 1 && port <= 65535)
    await page.waitForFunction(() => window.protocolRequests.length > 0);
  const requestId = () => page.evaluate(() => new URL(window.protocolRequests.at(-1)).searchParams.get('request'));
  return { page, requestId, protocolRequests };
}

async function runningBackend(t) {
  const f = await fixture(t, await fs.readFile('server.mjs', 'utf8'));
  await fs.copyFile('public/model.mjs', path.join(f.root, 'public/model.mjs'));
  const library = path.join(f.root, 'library');
  await fs.mkdir(library);
  const result = await f.start([], { ...process.env, HARMONICA_LIBRARY: library, HARMONICA_VAULT: f.root });
  assert.equal(result.code, 0, result.output);
  return f;
}

test('书签：服务已运行时直接进入，不调用协议或重新拉起启动器', { skip: !windows }, async t => {
  const f = await runningBackend(t);
  const logsBefore = (await f.logs()).length;
  const { page, protocolRequests } = await bookmark(t, f, f.port, false);
  await page.waitForURL(`http://127.0.0.1:${f.port}/`);
  assert.deepEqual(protocolRequests, []);
  assert.equal((await f.logs()).length, logsBefore);
});

test('快速就绪：只读file来源可检查，不泄露路径、不放开曲谱写入或远程站点', { skip: !windows }, async t => {
  const f = await runningBackend(t);
  const base = `http://127.0.0.1:${f.port}`;
  const response = await fetch(`${base}/api/launcher`, { headers: { Origin: 'null' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'null');
  assert.deepEqual(await response.json(), { ok: true, app: 'harmonica-studio', version: 1 });
  for (const [route, method, origin] of [
    ['/api/launcher', 'GET', 'https://example.invalid'],
    ['/api/launcher', 'POST', 'null'],
    ['/api/scores', 'GET', 'null'],
    ['/api/scores', 'POST', 'null'],
  ]) {
    const blocked = await fetch(base + route, { method, headers: { Origin: origin } });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  }
});

test('快速就绪：配置改库、资源缺失或坏配置都不能误报成功', { skip: !windows }, async t => {
  const f = await runningBackend(t);
  const url = `http://127.0.0.1:${f.port}/api/launcher`;
  await fs.writeFile(path.join(f.launcher, 'launcher.json'), JSON.stringify({port:f.port,data:path.join(f.root,'other')}));
  assert.equal((await fetch(url)).status, 409);
  await fs.writeFile(path.join(f.launcher, 'launcher.json'), JSON.stringify({port:f.port,data:f.data}));
  await fs.unlink(path.join(f.root, 'dist/app.js'));
  assert.equal((await fetch(url)).status, 503);
  await fs.writeFile(path.join(f.launcher, 'launcher.json'), '{broken');
  assert.equal((await fetch(url)).status, 503);
});

test('书签：隔离冷启动回执通过真实本机文件送回，原标签进入，重复启动复用', { skip: !windows }, async t => {
  const f = await fixture(t);
  const { page, requestId } = await bookmark(t, f);
  const id = await requestId();
  assert.equal((await f.start(['-Url', `harmonica://launch?port=${f.port}&request=${id}`])).code, 0);
  const report = await f.report(id);
  assert.equal(report.state, 'ready');
  assert.equal(report.requestId, id);
  assert.equal(report.appUrl, `http://127.0.0.1:${f.port}/`);
  await page.waitForURL(report.appUrl);
  assert.match(await page.title(), /Harmonica fixture/);
  const pid = (await f.health()).pid;
  const again = randomBytes(16).toString('hex');
  assert.equal((await f.start(['-Url', `harmonica://launch?port=${f.port}&request=${again}`])).code, 0);
  assert.equal((await f.report(again)).state, 'ready');
  assert.equal((await f.health()).pid, pid);
});

test('书签：配置损坏直接显示真实失败和日志，不回退曲库', { skip: !windows }, async t => {
  const f = await fixture(t);
  const { page, requestId } = await bookmark(t, f);
  const id = await requestId();
  await fs.writeFile(path.join(f.launcher, 'launcher.json'), '{broken');
  assert.equal((await f.start(['-Url', `harmonica://launch?port=${f.port}&request=${id}`])).code, 1);
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('launcher.json 无效'));
  assert.equal(await page.locator('#spinner').isVisible(), false);
  assert.equal(await page.locator('#diagnostics').isVisible(), true);
  assert.match(await page.locator('#logs').textContent(), /launch-.*\.log/);
  assert.equal((await f.report(id)).state, 'error');
  await page.setViewportSize({ width: 390, height: 844 });
  await fs.mkdir('work/bookmark-review', { recursive: true });
  await page.screenshot({ path: 'work/bookmark-review/config-error-mobile.png', fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'work/bookmark-review/config-error-desktop.png', fullPage: true });
});

test('书签：未授权12秒停止转圈，真实点击生成新请求，旧回执不能抢跳转', { skip: !windows }, async t => {
  const f = await fixture(t);
  const { page, requestId } = await bookmark(t, f);
  const oldId = await requestId();
  await page.clock.fastForward(12500);
  assert.equal(await page.locator('#status').textContent(), '未收到本机启动确认');
  assert.equal(await page.locator('#spinner').isVisible(), false);
  await fs.mkdir('work/bookmark-review', { recursive: true });
  await page.screenshot({ path: 'work/bookmark-review/no-ack.png', fullPage: true });
  await page.locator('#open').click();
  const id = await requestId();
  assert.notEqual(id, oldId);
  assert.equal(await page.locator('#spinner').isVisible(), true);
  await page.evaluate(({ oldId, port }) => window.harmonicaLaunchStatus({ requestId: oldId, state: 'ready', appUrl: `http://127.0.0.1:${port}/` }), { oldId, port: f.port });
  assert.match(page.url(), /^file:/);
  assert.equal((await f.start(['-Url', `harmonica://launch?port=${f.port}&request=${id}`])).code, 0);
  await page.waitForURL(`http://127.0.0.1:${f.port}/`);
});

test('书签：启动卡住60秒展示最后进度和日志，迟到结果不能再跳转', { skip: !windows }, async t => {
  const f = await fixture(t);
  const { page, requestId } = await bookmark(t, f);
  const id = await requestId();
  await page.evaluate(id => window.harmonicaLaunchStatus({ requestId: id, state: 'starting', message: '正在更新写谱台资源…', logPath: 'D:\\启动 日志\\launch-test.log' }), id);
  await page.clock.fastForward(61000);
  assert.match(await page.locator('#status').textContent(), /超过 60 秒/);
  assert.match(await page.locator('#hint').textContent(), /正在更新写谱台资源/);
  assert.equal(await page.locator('#spinner').isVisible(), false);
  await page.evaluate(({ id, port }) => window.harmonicaLaunchStatus({ requestId: id, state: 'ready', appUrl: `http://127.0.0.1:${port}/` }), { id, port: f.port });
  assert.match(page.url(), /^file:/);
});

test('书签：非法端口立即显示原因，不发送启动请求', { skip: !windows }, async t => {
  const f = await fixture(t);
  const { page } = await bookmark(t, f, 99999);
  assert.equal(await page.locator('#status').textContent(), '书签里的端口无效');
  assert.equal(await page.locator('#spinner').isVisible(), false);
  assert.equal(await page.evaluate(() => window.protocolRequests.length), 0);
});

test('书签：本机服务退出的具体异常在页面直接可见', { skip: !windows }, async t => {
  const f = await fixture(t, `console.error('fixture bookmark startup failure'); process.exit(27);`);
  const { page, requestId } = await bookmark(t, f);
  const id = await requestId();
  assert.equal((await f.start(['-Url', `harmonica://launch?port=${f.port}&request=${id}`])).code, 1);
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('退出码 27'));
  assert.match(await page.locator('#detail').textContent(), /fixture bookmark startup failure/);
  assert.equal(await page.locator('#spinner').isVisible(), false);
});

test('书签：协议分离启动窗口，保留端口和请求编号，失败通过回执报告', { skip: !windows }, async t => {
  const f = await fixture(t);
  const id = randomBytes(16).toString('hex');
  const entry = path.join(f.launcher, 'launch-from-protocol.bat');
  // Windows ShellExecute 会把主机名后的空路径规范化为 /。
  const url = `harmonica://launch/?port=${f.port}&request=${id}`;
  const runProtocol = address => new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec, ['/d', '/s', '/c', `""${entry}" "${address}""`], { windowsHide: true, windowsVerbatimArguments: true });
    let output = '';
    child.stdout.on('data', b => output += b.toString('utf8'));
    child.stderr.on('data', b => output += b.toString('utf8'));
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
  });
  const result = await runProtocol(url);
  assert.equal(result.code, 0, result.output);
  async function waitForReport(requestId, state) {
    const until = Date.now() + 12000;
    while (Date.now() < until) {
      try {
        const report = await f.report(requestId);
        if (report.state === state) return report;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error(`Missing ${state} report for ${requestId}`);
  }
  await waitForReport(id, 'ready');
  assert.equal((await f.report(id)).state, 'ready');
  await fs.writeFile(path.join(f.launcher, 'launcher.json'), '{broken');
  const failedId = randomBytes(16).toString('hex');
  const failed = await runProtocol(`harmonica://launch?port=${f.port}&request=${failedId}`);
  assert.equal(failed.code, 0, failed.output);
  assert.match((await waitForReport(failedId, 'error')).message, /launcher.json 无效/);
});

test('书签：错端口回执与反复点击不会抢跳转，脚本丢失也停止转圈', { skip: !windows }, async t => {
  const f = await fixture(t);
  const { page, requestId } = await bookmark(t, f);
  const initial = await requestId();
  await page.locator('#retry').click();
  await page.locator('#retry').click();
  const id = await requestId();
  assert.notEqual(id, initial);
  await page.evaluate(id => window.harmonicaLaunchStatus({ requestId: id, state: 'ready', appUrl: 'http://127.0.0.1:1/' }), id);
  assert.equal(await page.locator('#status').textContent(), '启动结果的地址与书签不一致');
  assert.equal(await page.locator('#spinner').isVisible(), false);
  await fs.unlink(path.join(f.launcher, 'launch-harmonica.js'));
  await page.reload();
  assert.equal(await page.locator('#status').textContent(), '启动页脚本未加载');
  assert.equal(await page.locator('#spinner').isVisible(), false);
});

test("启动器：同时双击只拉起一个实例", { skip: !windows }, async t => {
  const f = await fixture(t);
  const attempts = await Promise.all([f.start(), f.start()]);
  attempts.forEach(r => assert.equal(r.code, 0, r.output));
  assert.equal(attempts.filter(r => r.output.includes('正在启动本机服务')).length, 1);
  assert.equal((await f.logs()).length, 2);
  assert.equal((await f.health()).app, 'harmonica-studio');
});

test("启动器：真实后端以隔离曲库冷启动，健康检查与页面资源均通过", { skip: !windows }, async t => {
  const f = await fixture(t, await fs.readFile('server.mjs', 'utf8'));
  await fs.copyFile('public/model.mjs', path.join(f.root, 'public/model.mjs'));
  await fs.writeFile(path.join(f.root, 'dist/app.js'), 'console.log("isolated built frontend");');
  const library = path.join(f.root, 'library');
  await fs.mkdir(library);
  const result = await f.start([], { ...process.env, HARMONICA_LIBRARY: library, HARMONICA_VAULT: f.root });
  assert.equal(result.code, 0, result.output);
  const health = await f.health();
  assert.equal(health.app, 'harmonica-studio');
  assert.equal(health.dataDirectory, f.data);
  assert.equal(health.libraryCount, 0);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${f.port}/api/scores`)).json(), []);
});

for (const wrongData of [false, true]) {
  test(`启动器：拒绝复用${wrongData ? '另一个曲库' : '其他程序'}占用的端口`, { skip: !windows }, async t => {
    const f = await fixture(t);
    const occupied = http.createServer((req, res) => res.end(JSON.stringify({ ok: true, version: 1,
      app: wrongData ? 'harmonica-studio' : 'another-app', dataDirectory: path.join(f.root, 'other-data') })));
    await new Promise(resolve => occupied.listen(f.port, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => occupied.close(resolve)));
    const result = await f.start();
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, wrongData ? /另一个曲库/ : /其他程序/);
    assert.equal((await f.logs()).length, 1);
    await assert.rejects(() => fs.readFile(path.join(f.root, 'fixture.pid')), { code: 'ENOENT' });
  });
}

test("启动器：后台退出会报错，具体异常和旧日志都不丢", { skip: !windows }, async t => {
  const f = await fixture(t, `console.error('fixture startup failure'); process.exit(27);`);
  const first = await f.start();
  assert.equal(first.code, 1, first.output);
  assert.match(first.output, /退出码 27/);
  let logs = await f.logs();
  assert.match(logs[0].text, /fixture startup failure/);
  const firstLog = logs[0];
  assert.equal((await f.start()).code, 1);
  logs = await f.logs();
  assert.equal(logs.length, 2);
  assert.equal(logs.find(l => l.file === firstLog.file).text, firstLog.text);
});

test("启动器：配置损坏不悄悄切到默认曲库", { skip: !windows }, async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.launcher, 'launcher.json'), '{broken');
  const result = await f.start();
  assert.equal(result.code, 1);
  assert.match(result.output, /launcher.json 无效/);
  await assert.rejects(() => fs.readFile(path.join(f.root, 'fixture.pid')), { code: 'ENOENT' });
});

test("启动器：指定曲库不存在时停下，不创建空库替代", { skip: !windows }, async t => {
  const f = await fixture(t);
  const missing = path.join(f.root, 'missing-library');
  const result = await f.start(['-Data', missing]);
  assert.equal(result.code, 1);
  assert.match(result.output, /曲库目录不存在/);
  await assert.rejects(() => fs.access(missing), { code: 'ENOENT' });
});

test("启动器：服务未就绪超时报错，保留日志", { skip: !windows }, async t => {
  const f = await fixture(t, `console.log('still initializing'); setInterval(()=>{},1000);`);
  const result = await f.start();
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /等待服务就绪超时/);
  assert.match((await f.logs())[0].text, /still initializing/);
});

test("启动器：资源未构建时先构建，成功后才启动服务", { skip: !windows }, async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, 'dist/app.js'));
  await fs.mkdir(path.join(f.root, 'node_modules/esbuild'), { recursive: true });
  await fs.mkdir(path.join(f.root, 'scripts'));
  await fs.writeFile(path.join(f.root, 'scripts/build.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync('dist/app.js','rebuilt');`);
  const result = await f.start();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /正在更新写谱台资源/);
  assert.equal(await fs.readFile(path.join(f.root, 'dist/app.js'), 'utf8'), 'rebuilt');
});

test("启动器：缺少依赖或Node时给出具体原因，不假报成功", { skip: !windows }, async t => {
  const f = await fixture(t);
  await fs.unlink(path.join(f.root, 'dist/app.js'));
  const missingBuild = await f.start();
  assert.equal(missingBuild.code, 1, missingBuild.output);
  assert.match(missingBuild.output, /依赖未安装/);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'));
  env.Path = path.join(process.env.SystemRoot, 'System32');
  const missingNode = await f.start([], env);
  assert.equal(missingNode.code, 1);
  assert.match(missingNode.output, /未找到 Node.js/);
});

test("安装器：创建可见的本机快捷方式，备份旧URL，并保留现有曲库配置", { skip: !windows }, async t => {
  const f = await fixture(t);
  const old = '[InternetShortcut]\r\nURL=file:///old-launcher.html\r\n';
  await fs.writeFile(path.join(f.desktop, 'Harmonica.url'), old);
  const installer = path.join(f.launcher, 'install-launcher.ps1');
  const result = await run(installer, ['-DesktopDirectory', f.desktop]);
  assert.equal(result.code, 0, result.output);
  const config = JSON.parse((await fs.readFile(path.join(f.launcher, 'launcher.json'), 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(config.port, f.port);
  assert.equal(config.data, f.data);
  await fs.access(path.join(f.desktop, 'Harmonica.lnk'));
  await assert.rejects(() => fs.access(path.join(f.desktop, 'Harmonica.url')), { code: 'ENOENT' });
  const backups = (await fs.readdir(path.join(f.launcher, 'logs'))).filter(n => n.startsWith('install-backup-'));
  assert.equal(await fs.readFile(path.join(f.launcher, 'logs', backups[0], 'Harmonica.url'), 'utf8'), old);
  const inspector = path.join(f.root, 'inspect.ps1');
  await fs.writeFile(inspector, '\uFEFF' + `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${path.join(f.desktop, 'Harmonica.lnk').replaceAll("'", "''")}'); @{target=$s.TargetPath;arguments=$s.Arguments;style=$s.WindowStyle} | ConvertTo-Json`);
  const shortcut = JSON.parse((await run(inspector)).output);
  assert.match(shortcut.target, /cmd\.exe$/i);
  assert.match(shortcut.arguments, /open-harmonica\.cmd/);
  assert.equal(shortcut.style, 1);
  assert.equal((await run(installer, ['-DesktopDirectory', f.desktop])).code, 0);
});
