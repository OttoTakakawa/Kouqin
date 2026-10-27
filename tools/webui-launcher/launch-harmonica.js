/* file:// 书签入口：以本次请求的本机回执判断成功，不把图片加载当作服务就绪。 */
(() => {
  const params = new URLSearchParams(location.search);
  const portText = params.get("port") || "4317";
  const port = Number(portText);
  const appUrl = `http://127.0.0.1:${port}/`;
  const status = document.getElementById("status");
  const hint = document.getElementById("hint");
  const spinner = document.getElementById("spinner");
  const diagnostics = document.getElementById("diagnostics");
  const detail = document.getElementById("detail");
  const logs = document.getElementById("logs");
  const launchButton = document.getElementById("open");
  const retryButton = document.getElementById("retry");
  const protocolLink = document.getElementById("protocol");
  const acknowledgementTimeout = 12000;
  const startupTimeout = 60000;
  let current = null;
  let probeGeneration = 0;

  document.getElementById("endpoint").textContent = appUrl;

  function stop() {
    if (!current) return;
    clearInterval(current.timer);
    current.cancelRead?.();
    current = null;
  }

  function fail(message, explanation, report = {}) {
    stop();
    spinner.hidden = true;
    status.textContent = message;
    hint.textContent = explanation;
    detail.textContent = report.detail || "";
    logs.replaceChildren();
    for (const [label, file] of [
      ["启动日志", report.logPath],
      ["服务日志", report.serverLogPath],
    ]) {
      if (!file) continue;
      const link = document.createElement("a");
      link.textContent = `${label}：${file}`;
      link.href = new URL(`file:///${file.replaceAll("\\", "/")}`).href;
      link.target = "_blank";
      link.rel = "noopener";
      logs.append(link);
    }
    diagnostics.hidden = !detail.textContent && !logs.childElementCount;
  }

  // 经典 script 可读取同目录的本机回执，无需放开跨域 API 或浏览器安全策略。
  function readReport(attempt) {
    if (current !== attempt || attempt.reading) return;
    attempt.reading = true;
    const script = document.createElement("script");
    const finish = () => {
      clearTimeout(timeout);
      script.remove();
      attempt.reading = false;
      attempt.cancelRead = null;
    };
    const timeout = setTimeout(finish, 1000);
    attempt.cancelRead = finish;
    script.onload = finish;
    script.onerror = finish;
    script.src = `logs/status-${attempt.id}.js?t=${Date.now()}`;
    document.head.append(script);
  }

  window.harmonicaLaunchStatus = (report) => {
    const attempt = current;
    if (!attempt || report?.requestId !== attempt.id) return;
    if (!["starting", "ready", "error"].includes(report.state)) return;
    attempt.acknowledged = true;
    attempt.report = report;
    if (report.state === "error") {
      fail(report.message, "修正上面的原因后，点“重试启动”。", report);
      return;
    }
    if (report.state === "ready") {
      if (report.appUrl !== appUrl) {
        fail(
          "启动结果的地址与书签不一致",
          "没有跳转到其他端口，请检查书签里的端口。",
          report,
        );
        return;
      }
      stop();
      spinner.hidden = true;
      status.textContent = "写谱台已就绪，正在进入…";
      hint.textContent = "已确认服务、曲库和页面资源。";
      location.replace(appUrl);
      return;
    }
    status.textContent = "正在启动 Harmonica…";
    // 配置、地址和日志路径留在诊断里，主提示只显示正在执行的动作。
    hint.textContent = report.message;
  };

  function check(attempt) {
    if (current !== attempt) return;
    const elapsed = Date.now() - attempt.started;
    if (!attempt.acknowledged && elapsed >= acknowledgementTimeout) {
      fail(
        "未收到本机启动确认",
        "浏览器尚未交回本机启动结果。点“启动并进入”，若有打开应用的提示请选择“打开”。若完全不弹提示，请运行同目录的 install-protocol.ps1 修复协议；若浏览器仍不识别，保存网页内容后完整退出并重新打开浏览器，再试书签。",
      );
      return;
    }
    if (elapsed >= startupTimeout) {
      fail(
        "启动超过 60 秒，已停止等待",
        `最后进度：${attempt.report?.message || "等待启动器"}。请查看下面的日志后重试。`,
        attempt.report,
      );
      return;
    }
    readReport(attempt);
  }

  function launch() {
    probeGeneration++;
    stop();
    diagnostics.hidden = true;
    if (
      !/^\d{1,5}$/.test(portText) ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      fail(
        "书签里的端口无效",
        "端口必须为 1–65535；当前曲库使用 4318。请修改书签地址后重新打开。",
      );
      return;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const id = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const attempt = {
      id,
      started: Date.now(),
      acknowledged: false,
      reading: false,
    };
    current = attempt;
    spinner.hidden = false;
    status.textContent = "等待本机启动确认…";
    hint.textContent =
      "正在请求打开本机启动窗口。浏览器若询问是否打开 Harmonica，请选择“允许”；12 秒内未收到确认会显示处理办法。";
    // 必须在点击处理函数内直接触发，不能先 await 探测，否则可能失去用户手势。
    protocolLink.href = `harmonica://launch?port=${port}&request=${id}`;
    window.location.href = protocolLink.href;
    attempt.timer = setInterval(() => check(attempt), 500);
    check(attempt);
  }

  launchButton.addEventListener("click", launch);
  retryButton.addEventListener("click", launch);
  window.addEventListener("pagehide", stop);
  window.addEventListener("error", (event) => {
    if (event.message) fail("启动页运行出错", event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    fail("启动页运行出错", String(event.reason?.message || event.reason));
  });
  // 自动打开先快速判断已运行服务；按钮仍同步调用协议，保留真实点击手势。
  void (async () => {
    if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65535) {
      launch();
      return;
    }
    const generation = ++probeGeneration;
    status.textContent = "正在连接写谱台…";
    try {
      const response = await fetch(`${appUrl}api/launcher`, {
        cache: "no-store",
        signal: AbortSignal.timeout(500),
      });
      const report = await response.json();
      if (generation !== probeGeneration) return;
      if (
        response.ok &&
        report.ok === true &&
        report.app === "harmonica-studio" &&
        report.version === 1
      ) {
        spinner.hidden = true;
        status.textContent = "写谱台已就绪，正在进入…";
        location.replace(appUrl);
        return;
      }
      // 对旧服务、端口冲突或配置问题仍由本机脚本给出完整诊断与日志。
    } catch {}
    if (generation === probeGeneration) launch();
  })();
})();
