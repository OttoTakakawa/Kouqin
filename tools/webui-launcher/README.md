# Harmonica 本地启动器

给不习惯开终端的人准备的入口：双击打开本地写谱台，服务没开时自动把它拉起来。

```
tools/webui-launcher/     启动页、启动脚本、harmonica:// 协议注册
tools/edge-extension/     Edge / Chrome 扩展（Manifest V3）
```

## 最快的用法

和 Theater 一样，日常从桌面启动页进入，不需要浏览器扩展。首次配置运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\webui-launcher\install-launcher.ps1
```

已有新版 4318 曲库的本机请使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\webui-launcher\install-launcher.ps1 -Port 4318 -Data D:\Harmonica\data\rework-preview
```

安装器注册当前用户的启动协议、保存本地端口和曲库配置，并在桌面创建 **Harmonica** 入口。双击后在默认浏览器打开启动页，服务就绪后自动进入写谱台。浏览器询问是否打开 Harmonica 时选择允许。桌面入口绑定安装时选择的端口；更换端口后重新运行安装器。

也可以直接打开启动页：

1. 双击 `launch-harmonica.html`。
2. 页面先探测 `127.0.0.1:4317`，已经在跑就直接进写谱台。
3. 没跑时它会跳到 `harmonica://launch`，由 `start-harmonica.ps1` 在后台把服务拉起来，然后自动进入。

第一次用协议前，需要注册一次（只写当前用户的注册表，不需要管理员）：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\webui-launcher\install-protocol.ps1
```

检查 / 卸载：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\webui-launcher\install-protocol.ps1 -Status
powershell -ExecutionPolicy Bypass -File .\tools\webui-launcher\install-protocol.ps1 -Uninstall
```

注册后也可以直接 `Win+R` 输入 `harmonica://launch` 启动。

## 不想注册协议

双击 `run-harmonica-no-browser.bat` 启动服务，再打开 `launch-harmonica.html`
（或直接访问 `http://127.0.0.1:4317/`）。启动脚本会写日志到 `logs/`，
而且重复双击不会起第二个实例。

## 端口与数据目录

默认端口 4317、数据目录 `data/`。要长期改默认值，在
`tools/webui-launcher/launcher.json` 里写：

```json
{ "port": 4318, "data": "D:\\Harmonica\\data\\rework-preview" }
```

临时覆盖：

```powershell
.\tools\webui-launcher\run-harmonica-no-browser.bat -Port 4318
.\tools\webui-launcher\run-harmonica-no-browser.bat -Port 4318 -Data D:\Harmonica\data\rework-preview
```

启动页也支持查询参数：`launch-harmonica.html?port=4318`。
协议同样支持：`harmonica://launch?port=4318`。

## 可选的 Edge 扩展（无需安装）

扩展做的事很简单：点图标 → 检查本机服务 → 已运行就新开标签页，没运行就打开
扩展内的启动页，由它触发 `harmonica://` 把服务拉起来。

1. 先按上面的步骤注册协议（扩展本身不能启动本地进程，只能借协议）。
2. Edge 打开 `edge://extensions/`，右上角打开「开发人员模式」。
3. 点「加载解压缩的扩展」，选择 `tools/edge-extension` 目录。
4. 把「Harmonica 快捷入口」固定到工具栏。

Chrome 同理，地址换成 `chrome://extensions/`。

扩展 popup 里可以改端口，会记住上次的值。

## 常见问题

**点了没反应，地址栏没有任何提示**
浏览器在自动触发协议时可能要求一次用户手势。点启动页上的「重新启动」
或扩展 popup 里的「启动并打开」，都有真实点击，会再次触发。

**Edge 提示「已阻止打开此应用」**
在弹窗里选择允许；如果被永久拦截，去 `edge://settings/content/handlers`
检查，或直接用 `run-harmonica-no-browser.bat` 走手动路径。

**服务起不来**
看 `tools/webui-launcher/logs/server-日期.log`。最常见的是 Node.js
不在 PATH，或 4317 被别的程序占了（换个端口即可）。

**端口已经有人在听，但打不开页面**
启动脚本只判断端口是否被占用，不会验证占用者是谁。用浏览器直接访问
`http://127.0.0.1:4317/api/health` 确认是不是 Harmonica。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `launch-harmonica.html` | 独立启动页，探测 + 协议拉起 + 轮询 |
| `start-harmonica.ps1` | 检查端口、后台启动 `node server.mjs`、写日志 |
| `run-harmonica-no-browser.bat` | 上面脚本的入口，支持 `-Port` / `-Data` |
| `launch-from-protocol.bat` | `harmonica://` 协议的注册表处理程序 |
| `install-protocol.ps1` | 注册 / 查看 / 移除协议 |
| `launcher.json`（可选） | 默认端口与数据目录 |
| `logs/` | 服务输出日志，按日期命名 |
