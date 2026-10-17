/* 扩展内的启动页：探测 → 触发 harmonica:// → 轮询 → 进入写谱台 */

(() => {
  const params = new URLSearchParams(location.search);
  const port = /^\d{1,5}$/.test(params.get("port") || "")
    ? params.get("port")
    : "4317";
  const origin = `http://127.0.0.1:${port}`;
  const appUrl = `${origin}/`;
  const probeUrl = `${origin}/favicon.svg`;

  const statusEl = document.getElementById("status");
  const hintEl = document.getElementById("hint");
  const spinner = document.getElementById("spinner");
  document.getElementById("endpoint").textContent = appUrl;

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  let protocolRequested = false;
  let attempts = 0;
  let polling = false;

  function probe() {
    return new Promise((resolve) => {
      const img = new Image();
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        img.onload = null;
        img.onerror = null;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 1600);
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      img.src = `${probeUrl}?launcher=${Date.now()}`;
    });
  }

  function requestStart() {
    if (protocolRequested) return;
    protocolRequested = true;
    try {
      location.href = `harmonica://launch?port=${port}`;
    } catch {
      /* 浏览器阻止外部协议时留给轮询和手动按钮 */
    }
  }

  function enter() {
    statusEl.textContent = "写谱台已就绪，正在打开…";
    hintEl.textContent = "正在切换到 Harmonica。";
    spinner.hidden = true;
    location.replace(appUrl);
  }

  async function waitForApp() {
    if (polling) return;
    polling = true;
    while (polling) {
      if (await probe()) {
        polling = false;
        enter();
        return;
      }
      attempts += 1;
      if (attempts === 8) {
        statusEl.textContent = "仍在等待本机服务…";
        hintEl.textContent =
          "首次启动可能需要几秒。若没有反应，请先运行 run-harmonica-no-browser.bat。";
      }
      if (attempts === 24) {
        statusEl.textContent = "没有等到本机服务";
        hintEl.innerHTML =
          "服务没有启动。请双击 <code>run-harmonica-no-browser.bat</code>，再点“再试一次”。";
        spinner.hidden = true;
        polling = false;
        return;
      }
      await delay(1200);
    }
  }

  document.getElementById("open").addEventListener("click", async () => {
    if (await probe()) {
      enter();
      return;
    }
    spinner.hidden = true;
    statusEl.textContent = "服务还没启动";
    hintEl.innerHTML =
      "请先双击 <code>run-harmonica-no-browser.bat</code>，或点“再试一次”。";
  });

  document.getElementById("retry").addEventListener("click", () => {
    protocolRequested = false;
    attempts = 0;
    spinner.hidden = false;
    statusEl.textContent = "正在启动 Harmonica…";
    hintEl.textContent = "如果 Edge 询问是否打开 Harmonica，请选择“允许”。";
    requestStart();
    void waitForApp();
  });

  void (async () => {
    if (await probe()) {
      enter();
      return;
    }
    requestStart();
    void waitForApp();
  })();
})();
