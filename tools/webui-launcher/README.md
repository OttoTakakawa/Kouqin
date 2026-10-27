# Harmonica 本地启动器

给不习惯开终端的人准备的入口：双击打开本地写谱台，服务没开时自动把它拉起来。

```
tools/webui-launcher/     启动页、启动脚本、harmonica:// 协议注册
tools/edge-extension/     Edge / Chrome 扩展（Manifest V3）
```

## 最快的用法

浏览器书签可继续使用原地址，无需改书签：

```
file:///D:/Harmonica/tools/webui-launcher/launch-harmonica.html?port=4318&pin=1
```

页面先用最多500毫秒的只读检查确认服务、配置曲库和页面资源；已经运行就直接在当前标签页进入，不调用启动协议或PowerShell。没有运行或检查未通过时，才通过 `harmonica://` 请求本机启动，并读取本次启动回执。浏览器询问时选择“允许”；如果自动请求未获允许，点页面的 **启动并进入**，按钮会立即触发一次真实点击请求。`pin=1` 保留兼容，但不承担启动或固定标签页的功能。

需要唤醒时，从当前标签页交接协议（不使用隐藏iframe），协议处理程序用 `start` 拉起独立、可见的 **Harmonica Studio** PowerShell窗口，与Theater入口一致。窗口检查完成后退出，服务在后台继续运行，错误与日志仍回到书签页。浏览器授权尚未通过时，本机窗口不会凭页面自己出现；点“启动并进入”并在提示中允许。已有服务的快速直入不需要弹启动窗口。

启动器同时接受 `harmonica://launch?...` 和 Windows 规范化后的 `harmonica://launch/?...`，避免系统已拉起脚本却因多一个斜杠而被拒绝。协议解析之前就建立日志，非法地址也保留原因。

12秒没收到本机回执就停止转圈，明确显示“未收到本机启动确认”和操作办法，不把授权状态猜成服务错误。脚本已运行时，配置错误、端口占用、曲库不匹配、构建失败、服务退出等原因直接显示在页面，并附可打开的日志。总等待上限60秒，超时显示最后进度；重试生成新编号，旧结果不会抢跳转。页面会检查现有服务身份、曲库及首页/app.js，不再仅凭 favicon 判断成功。

首次使用协议需要运行一次 `install-protocol.ps1`；已经注册的本机不需要重新安装。书签页面、`launch-harmonica.js` 和脚本需保留在同一个目录。脚本回执写在忽略的 `logs/status-请求编号.js`，与曲谱分开；无需修改浏览器安全设置或安装扩展。

注册和卸载都会通过 `SHChangeNotify(SHCNE_ASSOCCHANGED)` 通知系统更新关联。如果 Windows 注册存在，但某个正在运行的浏览器仍报 `scheme does not have a registered handler`，不能把脚本测试通过当作浏览器已恢复。先保存网页内容，再完整退出并重新打开浏览器进行验证；不要强杀有未保存内容的浏览器。页面只能报告“未收到确认”，无法直接读取浏览器内部的协议注册错误。

### 可选：桌面入口

日常双击桌面 **Harmonica.lnk**：可见的本机启动窗口先检查配置、端口、服务身份与页面资源，就绪后才打开浏览器。成功自动关闭窗口，失败保留原因与日志路径。入口不依赖浏览器授权、HTML启动页或扩展。首次配置运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\webui-launcher\install-launcher.ps1
```

已有新版 4318 曲库的本机请使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\webui-launcher\install-launcher.ps1 -Port 4318 -Data D:\Harmonica\data\rework-preview
```

安装器保存端口和曲库配置，在桌面创建指向 `open-harmonica.cmd` 的 **Harmonica.lnk**。已有 `Harmonica.url` 和配置会先备份到 `logs/install-backup-时间/`，确认新快捷方式生成后再移除旧URL入口。无参数重复安装会保留已有配置，不会切回4317；默认不改协议注册。成功启动后窗口退出，后台服务继续运行。连续双击会复用同一服务。

### 协议注册

也可以直接打开启动页，但浏览器可能要求允许调用 `harmonica://`：

1. 打开带端口的书签；无端口时使用4317。
2. 页面向 `harmonica://launch` 发出带独立请求编号的启动请求。
3. `start-harmonica.ps1` 检查/复用或启动服务，通过本机回执向原标签页报告就绪或失败。

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

## 直接启动与调试

双击 `open-harmonica.cmd` 会按launcher.json启动并打开写谱台，与桌面新入口相同。`run-harmonica-no-browser.bat` 只检查并启动，不打开浏览器。二者遇到错误都会暂停保留窗口。

`start-harmonica.ps1 -Foreground` 可用于前台调试；`-StartupTimeoutSeconds` 调整就绪等待（默认25秒）。缺Node、配置错误、曲库路径丢失、错误端口占用、服务退出或超时会返回非零退出码。前端缺失或源代码较新时自动构建；依赖未安装时显示明确原因，不假报成功。

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
浏览器在自动触发协议时可能要求一次用户手势。点书签页上的「启动并进入」或「重试启动」，会在点击内立即请求本机启动；12秒未收到回执时页面停止等待并显示处理办法。浏览器是否拒绝或取消授权无法从页面精确读取，因此只报告“未收到确认”。扩展仍保留独立的旧启动逻辑，不使用本次书签回执通道。

**Edge 提示「已阻止打开此应用」**
在弹窗里选择允许；如果被永久拦截，去 `edge://settings/content/handlers`
检查，或直接用 `run-harmonica-no-browser.bat` 走手动路径。

**服务起不来**
错误窗口直接显示原因和日志路径。每次启动独立保存 `logs/launch-时间-标识.log`；新服务的标准输出和错误写入同标识的 `server-时间-标识.log`。日志不再覆盖前一次尝试，启动失败会在窗口与启动日志中附上最近的服务输出。

**端口已经有人在听，但打不开页面**
启动脚本检查 `/api/health` 的app身份与dataDirectory，以及首页和app.js能否读取。其他程序占用端口，或同端口Harmonica使用另一个曲库，会拒绝复用并保留错误，不会停止已有程序。升级前已运行的Harmonica可通过旧健康接口和页面标识复用，旧接口无法核对曲库路径；下次正常冷启动后使用完整检查。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `open-harmonica.cmd` | 桌面本机入口，检查就绪后打开浏览器，失败保留窗口 |
| `launch-harmonica.html` | 书签页，显示进度、失败原因和日志，原标签进入 |
| `launch-harmonica.js` | 请求编号、协议拉起、读取本机回执、超时与重试隔离 |
| `start-harmonica.ps1` | 配置/环境自检、同端口启动锁、健康和资源检查、后台服务、分次日志 |
| `run-harmonica-no-browser.bat` | 上面脚本的入口，支持 `-Port` / `-Data` |
| `launch-from-protocol.bat` | `harmonica://` 协议的注册表处理程序 |
| `install-protocol.ps1` | 注册 / 查看 / 移除协议 |
| `launcher.json`（可选） | 默认端口与数据目录 |
| `logs/` | 服务输出日志，按日期命名 |
