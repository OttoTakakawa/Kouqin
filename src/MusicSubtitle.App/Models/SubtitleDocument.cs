using System.Collections.ObjectModel;

namespace MusicSubtitle.Models;

/// <summary>字幕文档：有序 cue 集合 + 时间轴级操作。</summary>
public sealed class SubtitleDocument
{
    public ObservableCollection<SubtitleCue> Cues { get; } = new();

    /// <summary>源文件路径（未保存过则为空）。</summary>
    public string FilePath { get; set; } = "";

    /// <summary>源文件编码名（用于记录，保存统一走 UTF-8 BOM）。</summary>
    public string? SourceEncodingName { get; set; }

    public int Count => Cues.Count;

    /// <summary>按播放时间定位字幕（二分，Cues 保持有序）。</summary>
    public SubtitleCue? FindAt(TimeSpan t)
    {
        int lo = 0, hi = Cues.Count - 1;
        while (lo <= hi)
        {
            int mid = (lo + hi) >> 1;
            var c = Cues[mid];
            if (t < c.Start) hi = mid - 1;
            else if (t >= c.End) lo = mid + 1;
            else return c;
        }
        return null;
    }

    /// <summary>整体平移，夹到 0。</summary>
    public void ShiftAll(TimeSpan delta)
    {
        foreach (var c in Cues) c.Shift(delta);
    }

    /// <summary>
    /// 两点同步：把锚点字幕的当前时间 tA/tB 线性映射到目标时间 tA'/tB'，
    /// 全场（含区间外）应用同一线性映射。
    /// </summary>
    public void PointSync(SubtitleCue anchorA, TimeSpan targetA, SubtitleCue anchorB, TimeSpan targetB)
    {
        var tA = anchorA.Start;
        var tB = anchorB.Start;
        if (tA == tB || anchorA == anchorB) return;

        double k = (targetB - targetA).TotalSeconds / (tB - tA).TotalSeconds;
        var offset = targetA.TotalSeconds - k * tA.TotalSeconds;
        foreach (var c in Cues) c.Remap(t => TimeSpan.FromSeconds(t.TotalSeconds * k + offset));
    }

    /// <summary>整体缩放速度（时长压缩/拉伸，保持起点不动）。</summary>
    public void Stretch(double factor, TimeSpan pivot)
    {
        foreach (var c in Cues)
        {
            c.Remap(t => pivot + (t - pivot) * factor);
        }
    }
}
