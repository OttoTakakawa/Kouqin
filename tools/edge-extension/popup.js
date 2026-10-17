/* Harmonica 快捷入口 —— popup 逻辑
   只做三件事：读端口、探测本机服务、把用户送到正确的地方。 */

const DEFAULT_PORT = "4317";
const STORAGE_KEY = "harmonica.port";

const $ = (id) => document.getElementById(id);
const els = {
  state: $("state"),
  go: $("go"),
  dot: $("dot"),
  port: $("port"),
  recheck: $("recheck"),
  hint: $("hint"),
};

let port = DEFAULT_PORT;
let ready = false;
let busy = false;

const normalizePort = (value) => {
  const text = String(value ?? "").trim();
  return /^\d{1,5}$/.test(text) && Number(text) > 0 && Number(text) < 65536
    ? text
    : DEFAULT_PORT;
};

const appUrl = (p) => `http://127.0.0.1:${p}/`;

/**
 * 用图片探测服务是否可达：服务没起时连接被拒会触发 onerror。
 * 这里刻意不 fetch /api/health，避免跨源读取响应的问题。
 */
function probe(p, timeout = 1500) {
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
    const timer = setTimeout(() => finish(false), timeout);
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = `${appUrl(p)}favicon.svg?popup=${Date.now()}`;
  });
}

function render() {
  els.port.value = port;
  els.dot.dataset.state = ready ? "ready" : "down";

  if (busy) {
    els.dot.dataset.state = "";
    els.state.textContent = "正在检查本机服务…";
    els.go.textContent = "正在检查…";
    els.go.disabled = true;
    return;
  }

  if (ready) {
    els.state.innerHTML = `<strong>服务已在运行</strong><br>127.0.0.1:${port}`;
    els.go.textContent = "打开写谱台";
    els.go.disabled = false;
    els.hint.innerHTML =
      "已连接本机 Harmonica，直接打开即可，不需要启动协议。";
    return;
  }

  els.state.innerHTML = `<strong>服务未运行</strong><br>127.0.0.1:${port} 暂无响应`;
  els.go.textContent = "启动并打开";
  els.go.disabled = false;
  els.hint.innerHTML =
    "会通过 <code>harmonica://launch</code> 拉起本机服务；第一次使用需要先运行 <code>install-protocol.ps1</code>。";
}

async function check() {
  if (busy) return;
  busy = true;
  ready = false;
  render();
  ready = await probe(port);
  busy = false;
  render();
}

async function savePort() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: port });
  } catch {
    /* 无痕模式或权限被收回时忽略即可 */
  }
}

function openTab(url) {
  chrome.tabs.create({ url });
}

els.go.addEventListener("click", () => {
  if (ready) {
    openTab(appUrl(port));
    return;
  }
  openTab(`${chrome.runtime.getURL("launcher.html")}?port=${port}`);
});

els.recheck.addEventListener("click", () => {
  port = normalizePort(els.port.value);
  void savePort();
  void check();
});

els.port.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    els.recheck.click();
  }
});

els.port.addEventListener("blur", () => {
  const next = normalizePort(els.port.value);
  els.port.value = next;
  if (next === port) return;
  port = next;
  void savePort();
  void check();
});

void (async () => {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    port = normalizePort(stored?.[STORAGE_KEY]);
  } catch {
    port = DEFAULT_PORT;
  }
  await check();
})();
