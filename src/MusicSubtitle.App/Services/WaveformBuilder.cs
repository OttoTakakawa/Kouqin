using System.IO;
using NAudio.Wave;

namespace MusicSubtitle.Services;

/// <summary>用 NAudio 解码音频文件（wav/mp3/flac/aiff），聚合出波形峰值。</summary>
public static class WaveformBuilder
{
    /// <summary>解码并聚合峰值。耗时取决于文件长度，建议放后台线程。</summary>
    public static WaveformData Build(string path, IProgress<double>? progress = null)
    {
        using var afr = new AudioFileReader(path);
        int binSize = afr.WaveFormat.SampleRate / WaveformData.BinsPerSecond;
        if (binSize < 1) binSize = 1;

        int totalBins = (int)Math.Ceiling(afr.TotalTime.TotalSeconds * WaveformData.BinsPerSecond) + 1;
        var minima = new float[totalBins];
        var maxima = new float[totalBins];

        var buffer = new float[binSize * 2]; // 一次读一个 bin 的 2 倍，减少循环次数
        long totalRead = 0;
        long expectedTotal = (long)afr.TotalTime.TotalSeconds * afr.WaveFormat.SampleRate;

        int read;
        while ((read = afr.Read(buffer, 0, buffer.Length)) > 0)
        {
            int binIndex = (int)(totalRead / binSize);
            float min = 0f, max = 0f;
            for (int i = 0; i < read; i++)
            {
                float v = buffer[i];
                if (v < min) min = v;
                if (v > max) max = v;
            }
            if (binIndex < totalBins)
            {
                if (min < minima[binIndex]) minima[binIndex] = min;
                if (max > maxima[binIndex]) maxima[binIndex] = max;
            }
            totalRead += read;
            progress?.Report(expectedTotal > 0 ? Math.Min(1.0, totalRead / (double)expectedTotal) : 1.0);
        }

        return new WaveformData(afr.TotalTime.TotalSeconds, minima, maxima);
    }
}
