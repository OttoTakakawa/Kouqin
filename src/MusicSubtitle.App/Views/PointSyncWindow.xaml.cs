using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using MusicSubtitle.Models;
using MusicSubtitle.Services;

namespace MusicSubtitle.Views;

/// <summary>两点同步对话框：选两条锚点字幕，填目标时间，线性映射全场。</summary>
public partial class PointSyncWindow : Window
{
    private readonly PlaybackService _player;
    private readonly SubtitleCue _anchorA;
    private readonly SubtitleCue _anchorB;

    public PointSyncWindow(SubtitleDocument doc, PlaybackService player, TimeSpan currentPosition)
    {
        _player = player;
        InitializeComponent();
        // 默认锚点：当前播放位置前/后最近的字幕，没有就取首/尾
        var (a, b) = PickAnchors(doc, currentPosition);
        _anchorA = a;
        _anchorB = b;
        AnchorACombo.ItemsSource = doc.Cues;
        AnchorBCombo.ItemsSource = doc.Cues;
        AnchorACombo.SelectedItem = a;
        AnchorBCombo.SelectedItem = b;
        TargetAText.Text = SrtParser.FormatTime(a.Start);
        TargetBText.Text = SrtParser.FormatTime(b.Start);
        HintText.Text += $"  当前播放位置：{SrtParser.FormatTime(currentPosition)}";
    }

    private static (SubtitleCue, SubtitleCue) PickAnchors(SubtitleDocument doc, TimeSpan pos)
    {
        var cues = doc.Cues;
        int before = -1, after = -1;
        for (int i = 0; i < cues.Count; i++)
        {
            if (cues[i].End <= pos) before = i;
            else { after = i; break; }
        }
        if (before < 0 && after < 0) return (cues[0], cues[^1]);
        if (after < 0) return (cues[Math.Max(0, before - 1)], cues[before]);
        if (before < 0) return (cues[after], cues[Math.Min(cues.Count - 1, after + 1)]);
        return (cues[before], cues[after]);
    }

    public SubtitleCue AnchorA => (SubtitleCue)AnchorACombo.SelectedItem;
    public SubtitleCue AnchorB => (SubtitleCue)AnchorBCombo.SelectedItem;
    public TimeSpan TargetA => ParseTarget(TargetAText.Text, AnchorA.Start);
    public TimeSpan TargetB => ParseTarget(TargetBText.Text, AnchorB.Start);

    private void TakeNowA(object sender, RoutedEventArgs e) => TargetAText.Text = SrtParser.FormatTime(TimeSpan.FromMilliseconds(_player.Native.Time));
    private void TakeNowB(object sender, RoutedEventArgs e) => TargetBText.Text = SrtParser.FormatTime(TimeSpan.FromMilliseconds(_player.Native.Time));

    private void Ok_Click(object sender, RoutedEventArgs e)
    {
        if (AnchorACombo.SelectedItem == null || AnchorBCombo.SelectedItem == null ||
            AnchorACombo.SelectedItem == AnchorBCombo.SelectedItem)
        {
            MessageBox.Show("两条锚点必须选择不同的字幕。", "点同步", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        if (!TryParseTarget(TargetAText.Text, out _) || !TryParseTarget(TargetBText.Text, out _))
        {
            MessageBox.Show("目标时间格式不对，用 mm:ss.mmm 或 hh:mm:ss.mmm。", "点同步", MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }
        DialogResult = true;
    }

    private static TimeSpan ParseTarget(string text, TimeSpan fallback)
        => TryParseTarget(text, out var t) ? t : fallback;

    /// <summary>接受 mm:ss.mmm / hh:mm:ss.mmm / 纯秒（可带小数）；分隔符兼容 : 和 ,。</summary>
    private static bool TryParseTarget(string text, out TimeSpan result)
    {
        result = TimeSpan.Zero;
        text = text.Trim().Replace(',', '.');
        if (text.Length == 0) return false;

        var colonParts = text.Split(':');
        if (colonParts.Length > 3) return false;

        // 最后一段可含毫秒小数（m:ss.mmm / h:m:s.mmm），前面的段是整数
        double[] segs = new double[colonParts.Length];
        for (int i = 0; i < colonParts.Length; i++)
        {
            var dotParts = colonParts[i].Split('.');
            if (dotParts.Length > 2) return false;
            if (!double.TryParse(dotParts[0], NumberStyles.Float, CultureInfo.InvariantCulture, out segs[i]))
                return false;
            if (dotParts.Length == 2)
            {
                if (!double.TryParse(dotParts[1], NumberStyles.Float, CultureInfo.InvariantCulture, out var frac))
                    return false;
                // ".5" 按秒的小数；".500" 按毫秒三位处理（与 SRT 一致）
                double f = dotParts[1].Length == 3 ? frac / 1000.0 : frac / Math.Pow(10, dotParts[1].Length);
                segs[i] += f;
            }
        }

        double totalSeconds = colonParts.Length switch
        {
            1 => segs[0],
            2 => segs[0] * 60 + segs[1],
            _ => segs[0] * 3600 + segs[1] * 60 + segs[2]
        };
        if (totalSeconds < 0 || totalSeconds > 24 * 3600) return false;
        result = TimeSpan.FromSeconds(totalSeconds);
        return true;
    }
}
