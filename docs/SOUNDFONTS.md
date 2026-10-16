# 口琴音色候选 · 2026-10-17

状态：完成源码文档与资源存在性调研，尚未安装、接入或实际试听。

## 建议

优先试验 `smplr` + `FluidR3_GM` 的 `harmonica`。播放器和音色采样是两个独立部分。前者负责调度，后者决定声音。

| 候选 | 已确认事实 | 处理 |
| --- | --- | --- |
| [smplr](https://github.com/danigb/smplr) | 支持 Web Audio 采样乐器，可指定开始时间和持续时间，支持两套 Soundfont 音库 | 首选播放器候选 |
| [soundfont-player](https://github.com/danigb/soundfont-player) | 浏览器 Soundfont 加载与播放库；smplr 自述为它的现代替代 | 备选，不同时引入 |
| [FluidR3_GM harmonica](https://github.com/gleitz/midi-js-soundfonts/blob/gh-pages/FluidR3_GM/harmonica-mp3.js) | 口琴文件存在，GitHub 显示 2.58 MB | 首先试听 |
| [MusyngKite harmonica](https://github.com/gleitz/midi-js-soundfonts/blob/gh-pages/MusyngKite/harmonica-mp3.js) | 口琴文件存在，GitHub 显示 2.87 MB | 对照试听 |

本次 npm registry 查询得到 smplr 1.1.0、MIT。GitHub main 文档与 npm 发布版本可能不同；实际接入时固定版本并核对其 API，不能直接套 main 的示例。

## 对本项目的影响

- 把 degree / octave / sharp / key 转成绝对音高，再交给播放器。以音频时钟调度，持续秒数为 duration × 60 / bpm。
- 视觉播放位置根据同一时钟更新；特效关闭不改变调度或音量。
- 长音是重点验收项：smplr 的 Soundfont 循环功能标为实验性，可能出现点击声。不能因为 API 支持 duration 就认为采样能自然持续任意长度。[官方说明](https://github.com/danigb/smplr#soundfont-sustained-notes)
- 需要试听短音、连续同音、低中高音区和最长允许音长；当前 30 BPM × 8 拍可长达 16 秒。
- GM 口琴采样不等于特定半音阶口琴的真实吹吸表现，不能仅凭文件名承诺拟真度。
- 正式发布考虑将选定音色本地托管，避免每次依赖外网；本轮未下载或提交采样。
- 资源许可独立于播放器代码：上游注明 FluidR3_GM 为 CC BY 3.0、MusyngKite 为 CC BY-SA 3.0。随包分发时保留对应来源与许可，不把整个音色资源当成 MIT。[上游资源说明](https://github.com/gleitz/midi-js-soundfonts#soundfonts-available)

下一步：做独立试听页比较两套口琴采样，验证长音后再接正式编辑台。
