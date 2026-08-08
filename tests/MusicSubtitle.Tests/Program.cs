using System.Text;
using MusicSubtitle.Models;
using MusicSubtitle.Services;

// 自检：解析 / 写出往返 / 编码 / 点同步。全部通过则退出码 0。
Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
int failed = 0;

void Check(string name, bool cond)
{
    if (!cond) { Console.WriteLine($"FAIL: {name}"); failed++; }
    else Console.WriteLine($"ok: {name}");
}

// --- 1. 标准 SRT：序号 + 多行文本 + CRLF ---
const string srt1 =
    "1\r\n00:00:01,000 --> 00:00:03,500\r\n第一行\r\n第二行\r\n\r\n" +
    "2\r\n00:00:05,000 --> 00:00:08,000\r\nhello world\r\n\r\n" +
    "3\r\n00:00:10,000 --> 00:00:11,000\r\nlast\r\n";
var d1 = SrtParser.Parse(new StringReader(srt1));
Check("standard: cue count", d1.Count == 3);
Check("standard: start/end", d1.Cues[0].Start.TotalMilliseconds == 1000 && d1.Cues[0].End.TotalMilliseconds == 3500);
Check("standard: multiline text", d1.Cues[0].Text == "第一行\n第二行");
Check("standard: chinese roundtrip", d1.Cues[0].Text.Contains("第一行"));

// --- 2. 容错：无序号、点分隔毫秒、毫秒一位、小时一位 ---
const string srt2 =
    "00:00:01.5 --> 00:00:03.500\r\nno index dot ms\r\n\r\n" +
    "1:02:03,0 --> 1:02:04,00\r\nsingle digit hour/ms\r\n";
var d2 = SrtParser.Parse(new StringReader(srt2));
Check("tolerant: count", d2.Count == 2);
Check("tolerant: dot ms .5 = 500ms", d2.Cues[0].Start.TotalMilliseconds == 1500);
Check("tolerant: 1h2m3s = 3723s", d2.Cues[1].Start.TotalSeconds == 3723);

// --- 3. 写出 → 再解析 往返一致 ---
var tmp = Path.Combine(Path.GetTempPath(), "ms_rt_" + Guid.NewGuid().ToString("N") + ".srt");
try
{
    SrtParser.Save(d1, tmp);
    var bytes = File.ReadAllBytes(tmp);
    Check("save: utf8 BOM", bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF);
    Check("save: crlf", bytes.Contains((byte)0x0D));
    var dBack = SrtParser.Load(tmp);
    Check("roundtrip: count", dBack.Count == d1.Count);
    Check("roundtrip: times", dBack.Cues[2].Start == d1.Cues[2].Start && dBack.Cues[2].End == d1.Cues[2].End);
    Check("roundtrip: text", dBack.Cues[0].Text == d1.Cues[0].Text);
}
finally { File.Delete(tmp); }

// --- 4. GBK 编码文件（无 BOM）：中文必须不乱码 ---
var gbkPath = Path.Combine(Path.GetTempPath(), "ms_gbk_" + Guid.NewGuid().ToString("N") + ".srt");
try
{
    var gbk = Encoding.GetEncoding(936);
    string content = "1\n00:00:00,000 --> 00:00:02,000\n简体中文歌词测试\n";
    File.WriteAllText(gbkPath, content, gbk); // GBK 无 BOM
    var dGbk = SrtParser.Load(gbkPath);
    Check("gbk: decoded", dGbk.Cues.Count == 1 && dGbk.Cues[0].Text == "简体中文歌词测试");
    Check("gbk: source encoding recorded", dGbk.SourceEncodingName == "GBK");
}
finally { File.Delete(gbkPath); }

// --- 5. 点同步数学 ---
var d5 = new SubtitleDocument();
d5.Cues.Add(new SubtitleCue { Start = TimeSpan.FromSeconds(0), End = TimeSpan.FromSeconds(1), Text = "a" });
d5.Cues.Add(new SubtitleCue { Start = TimeSpan.FromSeconds(10), End = TimeSpan.FromSeconds(11), Text = "b" });
d5.Cues.Add(new SubtitleCue { Start = TimeSpan.FromSeconds(20), End = TimeSpan.FromSeconds(21), Text = "c" });
// 锚点：cue1(10s) → 12s，cue2(20s) → 18s；线性映射 k=(18-12)/(20-10)=0.6, offset=6
d5.PointSync(d5.Cues[1], TimeSpan.FromSeconds(12), d5.Cues[2], TimeSpan.FromSeconds(18));
Check("pointsync: anchor exact", Math.Abs(d5.Cues[1].Start.TotalSeconds - 12) < 1e-9 && Math.Abs(d5.Cues[2].Start.TotalSeconds - 18) < 1e-9);
Check("pointsync: extrapolate first", Math.Abs(d5.Cues[0].Start.TotalSeconds - 6) < 1e-9); // 0*0.6+6
Check("pointsync: end remapped too", Math.Abs(d5.Cues[0].End.TotalSeconds - 6.6) < 1e-9); // 1*0.6+6

// --- 6. FindAt 二分 ---
Check("findat: hit", d1.FindAt(TimeSpan.FromSeconds(1.5)) == d1.Cues[0]);
Check("findat: gap", d1.FindAt(TimeSpan.FromSeconds(4)) == null);
Check("findat: boundary end excluded", d1.FindAt(TimeSpan.FromSeconds(3.5)) == null);

// --- 7. ShiftAll 夹取 ---
d5.ShiftAll(TimeSpan.FromSeconds(-100));
Check("shiftall: clamped to zero", d5.Cues[0].Start == TimeSpan.Zero);

// --- 8. 波形提取：生成 10s 正弦 WAV → 聚合峰值 ---
var wavPath = Path.Combine(Path.GetTempPath(), "ms_wave_" + Guid.NewGuid().ToString("N") + ".wav");
try
{
    int rate = 44100;
    double secs = 10;
    var samples = new float[(int)(rate * secs)];
    for (int i = 0; i < samples.Length; i++)
        samples[i] = (float)(0.5 * Math.Sin(2 * Math.PI * 440 * i / rate)); // 振幅 0.5
    using (var ws = new NAudio.Wave.WaveFileWriter(wavPath, NAudio.Wave.WaveFormat.CreateIeeeFloatWaveFormat(rate, 1)))
        ws.WriteSamples(samples, 0, samples.Length);

    var wf = MusicSubtitle.Services.WaveformBuilder.Build(wavPath);
    Check("waveform: bin count ~10s*100", wf.BinCount >= 999 && wf.BinCount <= 1002);
    Check("waveform: global max ~0.5", Math.Abs(wf.GlobalMax - 0.5f) < 0.02f);
    Check("waveform: a mid bin peaks", Math.Abs(wf.Maxima[500] - 0.5f) < 0.05f && Math.Abs(wf.Minima[500] + 0.5f) < 0.05f);
    var rng = wf.Range(100, 101);
    Check("waveform: range aggregation", rng.Max >= wf.Maxima[100] && rng.Min <= wf.Minima[100]);
}
finally { File.Delete(wavPath); }

Console.WriteLine(failed == 0 ? "\nALL PASS" : $"\n{failed} FAILED");
return failed == 0 ? 0 : 1;
