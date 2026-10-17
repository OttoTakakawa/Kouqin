# 口琴音色候选 · 2026-10-17

状态：已接入 smplr 1.1.0 + 本地 FluidR3_GM 口琴采样，提供合成音备用。使用逐音校准的延音循环点；浏览器测试验证音频输出、暂停继续、A3 延音音高以及 16 秒音在末段仍有信号。拟真度仍需人工试听。

音量校准：这套口琴采样输出较轻，播放器使用 `extraGain: 20`、音色音量 `100`，再由底部音量滑块统一控制。相比初版 `1 / 70` 的设置，同一滑块位置的输出振幅提高约 40.8 倍；音色切换时的响度更接近合成音。

## 延音校准

原循环表为一组不同音高复用了相同采样偏移；套在逐音渲染的 MP3 上，部分循环长度不再匹配音高。例如 A3 原采样基频约 220.08 Hz，原循环后主频约 196.58 Hz。

现使用 `public/audio/harmonica-loops-calibrated.json`，从浏览器以 44100 Hz 解码的实际 MP3 波形逐音计算。保留原起音，在约 0.85–1.85 秒的稳定区域寻找 0.30–0.75 秒长的重复片段，同时匹配接缝两侧的波形与斜率。88 个采样分别校准，不再直接使用上游偏移。C/A 可用音域内 40 个音的循环基频相对各自原采样偏差小于 0.03 音分（离线波形分析值）。

开发时可将每个音导出为 44100 Hz、单声道 float32 PCM，再运行 `python scripts/calibrate-harmonica-loops.py <PCM目录> public/audio/harmonica-loops-calibrated.json` 重建，开发工具需要 numpy。校准表随前端打包，以 data URL 交给加载器，避免旧服务的静态路径白名单和旧资源缓存漏载循环点。原 MP3 与上游循环表保持原样，日常播放不需要 Python。

## 建议

当前使用 `smplr` + `FluidR3_GM` 的 `harmonica`。播放器和音色采样是两个独立部分。前者负责调度，后者决定声音。

| 候选                                                                                                           | 已确认事实                                                                 | 处理             |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------- |
| [smplr](https://github.com/danigb/smplr)                                                                       | 支持 Web Audio 采样乐器，可指定开始时间和持续时间，支持两套 Soundfont 音库 | 首选播放器候选   |
| [soundfont-player](https://github.com/danigb/soundfont-player)                                                 | 浏览器 Soundfont 加载与播放库；smplr 自述为它的现代替代                    | 备选，不同时引入 |
| [FluidR3_GM harmonica](https://github.com/gleitz/midi-js-soundfonts/blob/gh-pages/FluidR3_GM/harmonica-mp3.js) | 口琴文件存在，GitHub 显示 2.58 MB                                          | 首先试听         |
| [MusyngKite harmonica](https://github.com/gleitz/midi-js-soundfonts/blob/gh-pages/MusyngKite/harmonica-mp3.js) | 口琴文件存在，GitHub 显示 2.87 MB                                          | 对照试听         |

本次 npm registry 查询得到 smplr 1.1.0、MIT。GitHub main 文档与 npm 发布版本可能不同；实际接入时固定版本并核对其 API，不能直接套 main 的示例。

## 对本项目的影响

- 把 degree / octave / sharp / key 转成绝对音高，再交给播放器。以音频时钟调度，持续秒数为 duration × 60 / bpm。
- 视觉播放位置根据同一时钟更新；特效关闭不改变调度或音量。
- 长音是重点验收项：smplr 的 Soundfont 循环功能标为实验性，可能出现点击声。不能因为 API 支持 duration 就认为采样能自然持续任意长度。[官方说明](https://github.com/danigb/smplr#soundfont-sustained-notes)
- 需要试听短音、连续同音、低中高音区和最长允许音长；30 BPM × 8 拍在整体音长 1 倍时为 16 秒、2 倍时为 32 秒。
- GM 口琴采样不等于特定半音阶口琴的真实吹吸表现，不能仅凭文件名承诺拟真度。
- 已将选定音色与循环点元数据放在 `public/audio/`，由本机提供，日常播放不访问外网。来源见 [第三方说明](../THIRD_PARTY_NOTICES.md)。
- 资源许可独立于播放器代码：上游注明 FluidR3_GM 为 CC BY 3.0、MusyngKite 为 CC BY-SA 3.0。随包分发时保留对应来源与许可，不把整个音色资源当成 MIT。[上游资源说明](https://github.com/gleitz/midi-js-soundfonts#soundfonts-available)

后续可试听对比 MusyngKite 和更具体的半音阶口琴采样；当前不声称模拟真实口琴的吹吸、颤音或吐音技巧。

## 新增免费 MusyngKite 对照音色

「底部播放栏 → 音色」现在可选择「口琴 · FluidR3」「口琴 · MusyngKite」或合成音。原有选择保持不变；选择按本机偏好保存，不改变乐谱。两个采样乐器独立缓存，切换或停止会清除所有已加载乐器的发声，避免残音。

MusyngKite 文件原样保存在 public/audio；构建时作为纯文本内嵌到本地应用，运行时数据URL加载，兼容已有服务且不访问网络。许可为 CC BY-SA 3.0，完整条款与来源见 THIRD_PARTY_NOTICES.md 和 public/audio/MusyngKite-LICENSE.txt。

新音色使用独立的88音循环表。重建命令：`python scripts/calibrate-harmonica-loops.py work/musyngkite-pcm public/audio/musyngkite-loops-calibrated.json --musyngkite`。该采样存在包络衰减/音高起伏，因此循环搜索区间0.6–2.0秒、长度0.1–0.75秒，误差阈值与FluidR3分别设置；63个C/A倍音区可用音的循环音高相对原采样长段测量差小于8.1音分，不声称原库严格等律或长音完全拟真。

新增浏览器检查验证超过原始3.13秒采样长度后仍有输出、暂停静音/继续出声、两个采样音色往返切换、选择持久化及零外部网络请求；原音色音频与A3延音回归均通过。音质偏好仍应由用户实际试听判断。

## 其余免费音色

新增GeneralUser GS、VCSL常规、柔和、颤音，合计6种口琴采样音色，另保留合成音。都在「底部播放栏 → 音色」选择并记住偏好，音色切换停止上一种发声。新音色各自有延音循环表；VCSL只转调其9/10个实录采样锚点，不冒充全音区逐音实录。GeneralUser通过FluidSynth完整预设离线渲染88音，运行时不需要安装FluidSynth。完整来源与许可见THIRD_PARTY_NOTICES.md。
