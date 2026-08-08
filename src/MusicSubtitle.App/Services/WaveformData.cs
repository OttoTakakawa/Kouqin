namespace MusicSubtitle.Services;

/// <summary>
/// 波形峰值数据：音频按固定粒度聚合的 min/max 对。
/// 粒度默认 100 bins/秒（10ms），5 分钟音乐约 3 万 bin，内存与精度平衡；
/// 绘制时按像素覆盖的 bin 范围再聚合，缩放任意深度都有平滑波形。
/// </summary>
public sealed class WaveformData
{
    public const int BinsPerSecond = 100;

    public double DurationSeconds { get; }
    public float[] Minima { get; }
    public float[] Maxima { get; }
    public float GlobalMax { get; }

    public int BinCount => Minima.Length;

    public WaveformData(double durationSeconds, float[] minima, float[] maxima)
    {
        DurationSeconds = durationSeconds;
        Minima = minima;
        Maxima = maxima;
        GlobalMax = 1e-6f;
        foreach (var m in maxima)
            if (m > GlobalMax) GlobalMax = m;
        foreach (var m in minima)
            if (-m > GlobalMax) GlobalMax = -m;
    }

    public double SecondsPerBin => 1.0 / BinsPerSecond;

    public long TimeToBin(TimeSpan t) => (long)(t.TotalSeconds * BinsPerSecond);

    public TimeSpan BinToTime(long bin) => TimeSpan.FromSeconds(bin / (double)BinsPerSecond);

    /// <summary>取 [binStart, binEnd) 范围的聚合 min/max（绘制一像素列时用）。</summary>
    public (float Min, float Max) Range(long binStart, long binEnd)
    {
        binStart = Math.Clamp(binStart, 0, BinCount - 1);
        binEnd = Math.Clamp(binEnd, binStart + 1, BinCount);
        float min = 0f, max = 0f;
        for (long i = binStart; i < binEnd; i++)
        {
            if (Minima[i] < min) min = Minima[i];
            if (Maxima[i] > max) max = Maxima[i];
        }
        return (min, max);
    }
}
