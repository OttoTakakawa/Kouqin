using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using MusicSubtitle.Models;

namespace MusicSubtitle.Services;

/// <summary>
/// SRT 解析/写出。要点：
/// - 编码检测：BOM（UTF-8/UTF-16）→ 无 BOM 时先严格 UTF-8 校验，失败回退 GBK（中文字幕常态）
/// - 时间行容错：接受 1-2 位小时、逗号或点分隔毫秒、毫秒 1-3 位
/// - 保存统一 UTF-8 带 BOM（Windows 播放器最兼容）+ CRLF
/// </summary>
public static class SrtParser
{
    private static readonly Regex TimeLineRx = new(
        @"^\s*(?<sh>\d{1,2}):(?<sm>\d{1,2}):(?<ss>\d{1,2})[,\.](?<sms>\d{1,3})\s*-->\s*(?<eh>\d{1,2}):(?<em>\d{1,2}):(?<es>\d{1,2})[,\.](?<ems>\d{1,3})\s*$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>加载文件（自动检测编码）。</summary>
    public static SubtitleDocument Load(string path)
    {
        var (encoding, name) = DetectEncoding(path);
        using var sr = new StreamReader(path, encoding);
        var doc = Parse(sr);
        doc.FilePath = path;
        doc.SourceEncodingName = name;
        return doc;
    }

    public static SubtitleDocument Parse(TextReader reader)
    {
        var doc = new SubtitleDocument();
        TimeSpan start = default, end = default;
        var text = new StringBuilder();
        bool haveTime = false;

        string? line;
        while ((line = reader.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                Flush();
                continue;
            }

            if (haveTime)
            {
                if (text.Length > 0) text.Append('\n');
                text.Append(line);
            }
            else
            {
                // 时间行是唯一带 "-->" 的行；序号行（纯数字）等其他行直接跳过
                var m = TimeLineRx.Match(line);
                if (m.Success)
                {
                    start = ParseTime(m, "s");
                    end = ParseTime(m, "e");
                    haveTime = true;
                    text.Clear();
                }
            }
        }
        Flush();
        return doc;

        void Flush()
        {
            if (haveTime)
            {
                if (text.Length > 0)
                {
                    doc.Cues.Add(new SubtitleCue { Start = start, End = end, Text = text.ToString() });
                }
                haveTime = false;
                text.Clear();
            }
        }
    }

    /// <summary>保存：UTF-8 带 BOM、CRLF、规范格式。</summary>
    public static void Save(SubtitleDocument doc, string path)
    {
        using var fs = new FileStream(path, FileMode.Create, FileAccess.Write);
        using var sw = new StreamWriter(fs, new UTF8Encoding(true));
        int index = 1;
        foreach (var cue in doc.Cues)
        {
            sw.Write(index++);
            sw.Write("\r\n");
            sw.Write(FormatTime(cue.Start));
            sw.Write(" --> ");
            sw.Write(FormatTime(cue.End));
            sw.Write("\r\n");
            sw.Write(cue.Text);
            sw.Write("\r\n\r\n");
        }
    }

    public static string FormatTime(TimeSpan t)
    {
        return $"{(int)t.TotalHours:00}:{t.Minutes:00}:{t.Seconds:00},{t.Milliseconds:000}";
    }

    private static TimeSpan ParseTime(Match m, string p)
    {
        int ms = int.Parse(m.Groups[p + "ms"].Value.PadRight(3, '0')); // 一位/两位毫秒补齐到三位
        return new TimeSpan(0,
            int.Parse(m.Groups[p + "h"].Value),
            int.Parse(m.Groups[p + "m"].Value),
            int.Parse(m.Groups[p + "s"].Value),
            ms);
    }

    /// <summary>编码检测：BOM 优先，无 BOM 走 UTF-8 严格校验，失败回退 GBK(936)。</summary>
    public static (Encoding Encoding, string Name) DetectEncoding(string path)
    {
        using var fs = File.OpenRead(path);
        Span<byte> head = stackalloc byte[4];
        int n = fs.Read(head);
        if (n >= 3 && head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF)
            return (new UTF8Encoding(true), "UTF-8 BOM");
        if (n >= 2 && head[0] == 0xFF && head[1] == 0xFE)
            return (Encoding.Unicode, "UTF-16 LE");
        if (n >= 2 && head[0] == 0xFE && head[1] == 0xFF)
            return (Encoding.BigEndianUnicode, "UTF-16 BE");

        // 无 BOM：读全文严格 UTF-8 校验
        byte[] bytes = File.ReadAllBytes(path);
        try
        {
            _ = new UTF8Encoding(false, true).GetString(bytes);
            return (new UTF8Encoding(false), "UTF-8");
        }
        catch (DecoderFallbackException)
        {
            var gbk = Encoding.GetEncoding(936); // 需 CodePagesEncodingProvider
            return (gbk, "GBK");
        }
    }
}
