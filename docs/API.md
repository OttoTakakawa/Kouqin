# 本地后端 API · v1

运行环境：Node.js 22 或更高版本。首次运行 `npm ci`，之后 `npm start` 自动构建前端并监听 `http://127.0.0.1:4317`。仅限本机，尚不支持局域网、账号或多人访问。

环境变量：`PORT`、`HARMONICA_LIBRARY`（Markdown 乐谱目录）、`HARMONICA_VAULT`（附件搜索根目录）、`HARMONICA_DATA`（新谱数据目录，默认项目下 data）。默认库指向用户现有 F 盘口琴乐谱，附件搜索根目录为软件笔记。

| 请求                    | 用途                                           |
| ----------------------- | ---------------------------------------------- |
| GET /api/health         | 服务状态、库数量和读取异常                     |
| GET /api/library        | 原谱列表：id、title、category                  |
| GET /api/original?id=0  | 原 Markdown 和可访问的图片 URL                 |
| GET /api/image?id=0&n=0 | 该原谱引用的第 n 张图片                        |
| GET /api/scores         | 所有新建谱                                     |
| POST /api/scores        | 创建或覆盖同 id 的新谱；校验后临时文件原子替换 |
| DELETE /api/scores/:id  | 将新谱移入 data/trash；不删除原有 Markdown     |

原谱只读。库在启动时扫描，增加文件后需重启；原谱 id 仅在当前扫描内有效，不应用作永久外键。图片首次访问时搜索附件，重名图片返回错误而非猜测。当前支持 Obsidian `![[图片.png|宽度]]` 引用，不包含普通 Markdown 图片语法。

## 新谱格式

```json
{
  "version": 1,
  "id": "unique-score-id",
  "title": "新乐谱",
  "key": "C",
  "bpm": 90,
  "notes": [
    { "type": "note", "degree": 1, "octave": 0, "sharp": false, "duration": 1 },
    {
      "type": "note",
      "degree": 2,
      "octave": 1,
      "sharp": true,
      "duration": 1.375
    },
    {
      "type": "note",
      "degree": 0,
      "octave": 0,
      "sharp": false,
      "duration": 0.5
    },
    { "type": "break" }
  ]
}
```

`degree` 为 0–7，其中 0 为休止；`octave` 为 -1、0、1；`duration` 是相对拍长，范围 0.125–8，可小数微调；真实秒数为 duration × 60 / bpm。换行不自动加入停顿。`{"type":"space"}` 仅作视觉分组，不占播放时长。C 调中音 1 暂定 C4，A 调中音 1 暂定 A3，推键暂按升半音。以上可在体验后调整，不代表已对用户乐器完成校准。

可选字段：`category`（100 字内）、`favorite`（布尔）、`status`（未练习 / 练习中 / 熟练）。服务器在保存成功后返回并写入 `updatedAt`。同 ID 保存串行执行，覆盖前保留 `.json.bak`；GET 列表排除备份与回收目录。

模型转谱输出此 JSON 可通过前端导入（创建新 ID），或直接调用保存接口（同 ID 覆盖）。目前没有接入模型、OCR 或自动推断时值。纯文本导入默认每音 1 拍，拒绝错配括号；空白不会被猜成音长。旧笔记正文以纯文本显示，不执行原文 HTML。

## 后续前端约定

- 正式前端已接入保存与播放；设计档案只用于保留早期提案。
- 前端布局提案见 `docs/design/harmonica-studio.html`。无右侧原谱对照栏；当前绿色配色未定稿。
- 播放高亮与装饰音符特效分开处理；特效可关闭、保存偏好，首次访问尊重减少动态效果设置。
- 自定义快捷键在谱面获得焦点时生效，避免拦截全局浏览器操作。
- 只用 Z / C 编辑时值，支持细调，不采用按住计时。
- 播放调度以音频时钟为准，视觉特效跟随播放位置，不能反过来影响节奏。
- 已接入本地口琴采样与合成音；来源与测试边界见 `docs/SOUNDFONTS.md`。
- 批量转谱若使用子代理，仅使用 Luna 或 GPT-6.1-sol medium；转谱结果需人工校对。

## 当前限制

同 id 最后保存覆盖之前内容，无多用户版本冲突合并；只保留上一次保存备份，删除项进入本机回收目录。附件目录首次扫描可能较慢。原谱和附件不复制进仓库。JSON 上传界面和键盘编辑已实现；自动转谱、音频识谱不在第一版中。
