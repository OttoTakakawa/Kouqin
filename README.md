# Music Subtitle Tool

**C# 通用的字幕编辑工具** —— 加载 SRT + 视频/音乐，播放校对时间轴，保存 SRT。
核心卖点：时间轴校对（对齐、平移、点同步），而不是打字幕。

> 前置调研记录（SubtitleEdit 参考等）见文末。

## 运行

```
dotnet run --project src/MusicSubtitle.App
```

依赖 .NET 8 SDK。LibVLC 运行库由 NuGet 包自带（无需安装 VLC）。
命令行参数可传媒体/字幕文件；也支持拖入窗口。

## 已实现（MVP）

- SRT 解析/写出：编码自动检测（UTF-8 BOM / UTF-16 / 无 BOM UTF-8 严格校验 → GBK 回退），时间格式容错（点/逗号毫秒、1-2 位小时），保存 UTF-8 BOM + CRLF
- 播放：LibVLC 音视频通吃，速率 0.25~4x、进度条拖动、双击字幕跳转播放
- 时间轴：自绘控件 —— 波形（NAudio 峰值，音频文件）、字幕块拖拽（整块/左右边缘）、播放头拖动 seek、滚轮缩放（锚定鼠标）、右键平移、双击标尺全览、播放自动跟随
- 校对：`[`/`]` 微调起点（±100ms，Shift 大步 ±500ms，Alt 微调终点）、整体平移 ±0.5s、两点同步（线性映射全场）、当前字幕歌词大字预览
- 字幕列表：选中同步、文本行内编辑、双击跳转

## 快捷键

| 按键 | 功能 |
|------|------|
| Space | 播放/暂停 |
| ← / → | 后退/前进 1s（Shift ±100ms，Ctrl ±5s） |
| [ / ] | 当前字幕起点 −/+100ms |
| Shift+[ / ] | 起点 −/+500ms |
| Alt+[ / ] | 终点 −/+100ms |
| ↑ / ↓ | 上一条/下一条字幕（跳转） |
| Ctrl+S / Ctrl+Shift+S | 保存 / 另存为 |
| Ctrl+P | 点同步 |
| F5 | 时间轴全览 |
| Esc | 暂停 |

## 项目结构

```
src/MusicSubtitle.App/
  Models/        SubtitleCue（INPC）、SubtitleDocument（ShiftAll/PointSync/Stretch/FindAt）
  Services/      SrtParser（编码检测）、WaveformBuilder（NAudio 峰值）、PlaybackService（LibVLC）
  Controls/      WaveformTimeline（自绘时间轴）
  ViewModels/    MainViewModel
  Views/         MainWindow、PointSyncWindow
tests/           自检（解析/编码/点同步/波形）
samples/         测试素材（60s 生成音乐 + 字幕）
```

## 待办

- [ ] 字幕文本编辑增强（列表内双击直接编辑）
- [ ] 波形对视频文件支持（LibVLC 提取音频 → NAudio 峰值）
- [ ] 多字幕轨 / 自动同步（音频指纹）
- [ ] 未保存更改的标题栏标记

---

# 调研记录（前置）

## 已确认的技术选型方向

| 模块 | 方案 | 说明 |
|------|------|------|
| UI 框架 | **WPF .NET 8** | 复用 Theater/Videotapes 的既有栈 |
| 播放器 | **LibVLCSharp** | 用户已有经验；音视频通吃 |
| SRT 解析/写出 | **自写** | SRT 格式简单；中文用户核心痛点是无 BOM GBK 字幕，第三方库编码处理不可控 |
| 波形显示 | **NAudio** 解音频峰值 + 自绘 WPF 控件 | 波形是"校对时间轴"的锚点，字幕块直接拖在波形上 |

## GitHub 参考项目

### SubtitleEdit（最重要的参考，MIT）
https://github.com/SubtitleEdit/subtitleedit
- C#/.NET，MIT 协议，最完整的开源字幕编辑器
- 视频播放走 **mpv + ffmpeg**（自包含，音视频都支持）
- 时间轴功能全家桶：**点同步**（选 2~3 个对齐点做线性重映射）、**波形/视觉同步**、整体平移、自动同步（音频指纹，类似 ffsubsync 的算法）、字幕转换
- 我们不做那么重，但"点同步"和"波形对齐"是校对时间轴的核心体验，值得抄
- 文档站：http://subtitleedit.github.io/subtitleedit/

### 波形/时间轴控件（自绘 WPF 的起点）
- markheath/wpf-waveform：NAudio 作者实验性 WPF 波形控件（可并入 NAudio）
- jacobjohnstown/wpfsvl：Waveform Timeline 控件（timeline/waveform/progress 三区）
- NAudio.WaveFormRenderer：把波形渲染成 PNG（离线峰值提取思路）

### 自动同步算法参考
- ffsubsync（Python）：音频指纹 + 对齐算法，思路可移植到 C#（可选增强，先不做）

## 待定问题
- [ ] 是否需要**字幕渲染预览**（把字幕烧到播放画面/视频上）还是只编辑+保存 SRT？
- [ ] 只做 SRT 还是顺带 LRC/ASS/VTT 转换？（SubtitlesParserV2 可直接支持）
- [ ] 自动同步（音频指纹对齐）做不做？做的话引入 ffsubsync 算法移植

## 建议的 MVP 边界
1. 拖入媒体文件 + SRT → 播放，波形显示，当前字幕高亮
2. 字幕块可拖拽/微调时间（+ 快捷键逐条校对）
3. 整体平移 / 点同步（2 点线性映射）
4. 保存 SRT

## 调研记录

（2026-08-08 首轮搜索完成，见上）
