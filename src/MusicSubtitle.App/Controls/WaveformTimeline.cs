using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using MusicSubtitle.Models;

namespace MusicSubtitle.Controls;

/// <summary>
/// 自绘时间轴：标尺 + 波形 + 字幕块 + 播放头。
/// 交互：拖播放头/点空白 seek；拖字幕块整体；拖左右边缘改起止；滚轮缩放（锚定鼠标）；
/// 右键拖平移；双击标尺全览；双击字幕块跳转播放。
/// </summary>
public sealed class WaveformTimeline : FrameworkElement
{
    // ---- 依赖属性 ----
    public static readonly DependencyProperty CuesProperty = DependencyProperty.Register(
        nameof(Cues), typeof(IReadOnlyList<SubtitleCue>), typeof(WaveformTimeline),
        new PropertyMetadata(null, OnVisualChanged));

    public static readonly DependencyProperty WaveformProperty = DependencyProperty.Register(
        nameof(Waveform), typeof(Services.WaveformData), typeof(WaveformTimeline),
        new PropertyMetadata(null, OnVisualChanged));

    public static readonly DependencyProperty PlaybackPositionProperty = DependencyProperty.Register(
        nameof(PlaybackPosition), typeof(TimeSpan), typeof(WaveformTimeline),
        new FrameworkPropertyMetadata(TimeSpan.Zero, FrameworkPropertyMetadataOptions.AffectsRender));

    public static readonly DependencyProperty MediaDurationProperty = DependencyProperty.Register(
        nameof(MediaDuration), typeof(TimeSpan), typeof(WaveformTimeline),
        new PropertyMetadata(TimeSpan.Zero, OnVisualChanged));

    public static readonly DependencyProperty SelectedCueProperty = DependencyProperty.Register(
        nameof(SelectedCue), typeof(SubtitleCue), typeof(WaveformTimeline),
        new PropertyMetadata(null, OnVisualChanged));

    public static readonly DependencyProperty CurrentCueProperty = DependencyProperty.Register(
        nameof(CurrentCue), typeof(SubtitleCue), typeof(WaveformTimeline),
        new PropertyMetadata(null, OnVisualChanged));

    public IReadOnlyList<SubtitleCue>? Cues { get => (IReadOnlyList<SubtitleCue>?)GetValue(CuesProperty); set => SetValue(CuesProperty, value); }
    public Services.WaveformData? Waveform { get => (Services.WaveformData?)GetValue(WaveformProperty); set => SetValue(WaveformProperty, value); }
    public TimeSpan PlaybackPosition { get => (TimeSpan)GetValue(PlaybackPositionProperty); set => SetValue(PlaybackPositionProperty, value); }
    public TimeSpan MediaDuration { get => (TimeSpan)GetValue(MediaDurationProperty); set => SetValue(MediaDurationProperty, value); }
    public SubtitleCue? SelectedCue { get => (SubtitleCue?)GetValue(SelectedCueProperty); set => SetValue(SelectedCueProperty, value); }
    public SubtitleCue? CurrentCue { get => (SubtitleCue?)GetValue(CurrentCueProperty); set => SetValue(CurrentCueProperty, value); }

    /// <summary>点击选中字幕。</summary>
    public event Action<SubtitleCue>? CueSelected;
    /// <summary>拖拽修改了字幕时间。</summary>
    public event Action<SubtitleCue>? CueTimingChanged;
    /// <summary>拖动播放头/点击空白。</summary>
    public event Action<TimeSpan>? SeekRequested;
    /// <summary>双击字幕块：跳转播放。</summary>
    public event Action<SubtitleCue>? CueActivated;

    // ---- 布局常量 ----
    private const double RulerHeight = 24;
    private const double CueLaneHeight = 24;
    private const double PlayheadHitWidth = 6;

    // ---- 视口状态 ----
    private double _pps = 80;              // pixels per second
    private TimeSpan _viewStart = TimeSpan.Zero;
    private enum DragMode { None, Playhead, CueMove, CueStart, CueEnd, Pan }
    private DragMode _drag = DragMode.None;
    private SubtitleCue? _dragCue;
    private Point _dragLast;
    private TimeSpan _dragStartTime;       // 拖拽开始时 cue.Start
    private TimeSpan _dragEndTime;         // 拖拽开始时 cue.End
    private TimeSpan _viewStartAtDrag;


    static WaveformTimeline()
    {
        FocusableProperty.OverrideMetadata(typeof(WaveformTimeline), new FrameworkPropertyMetadata(true));
        CursorProperty.OverrideMetadata(typeof(WaveformTimeline), new FrameworkPropertyMetadata(Cursors.Arrow));
    }

    public WaveformTimeline()
    {
        ClipToBounds = true;
        SnapsToDevicePixels = true;
    }

    private void HandleDoubleClick(MouseButtonEventArgs e)
    {
        var p = e.GetPosition(this);
        // 双击标尺：全览适配
        if (p.Y < RulerHeight)
        {
            FitAll();
            e.Handled = true;
            return;
        }
        var cue = HitTestCue(p.X, p.Y);
        if (cue != null)
        {
            CueActivated?.Invoke(cue);
            e.Handled = true;
        }
    }

    private static void OnVisualChanged(DependencyObject d, DependencyPropertyChangedEventArgs e)
        => ((WaveformTimeline)d).InvalidateVisual();

    // ---- 坐标换算 ----
    private double X(TimeSpan t) => (t - _viewStart).TotalSeconds * _pps;
    private TimeSpan TimeAt(double x) => _viewStart + TimeSpan.FromSeconds(x / _pps);
    private double WaveTop => RulerHeight + CueLaneHeight;
    private double WaveBottom => ActualHeight - 2;

    // ---- 鼠标交互 ----
    protected override void OnMouseWheel(MouseWheelEventArgs e)
    {
        double anchorX = e.GetPosition(this).X;
        var anchorTime = TimeAt(anchorX);
        double factor = Math.Pow(1.25, e.Delta / 120.0);
        double newPps = Math.Clamp(_pps * factor, 0.1, 4000);
        _pps = newPps;
        _viewStart = anchorTime - TimeSpan.FromSeconds(anchorX / _pps);
        ClampView();
        InvalidateVisual();
        e.Handled = true;
    }

    protected override void OnMouseDown(MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2 && e.ChangedButton == MouseButton.Left)
        {
            HandleDoubleClick(e);
            return;
        }

        Focus();
        var p = e.GetPosition(this);

        if (e.ChangedButton == MouseButton.Right)
        {
            _drag = DragMode.Pan;
            _dragLast = p;
            _viewStartAtDrag = _viewStart;
            Cursor = Cursors.ScrollAll;
            e.Handled = true;
            return;
        }

        // 字幕块命中（优先于播放头，块在播放头上层）
        var cue = HitTestCue(p.X, p.Y);
        if (cue != null)
        {
            SelectedCue = cue;
            CueSelected?.Invoke(cue);
            double edge = 5;
            double leftX = X(cue.Start), rightX = X(cue.End);
            _dragCue = cue;
            _dragStartTime = cue.Start;
            _dragEndTime = cue.End;
            if (Math.Abs(p.X - leftX) <= edge && p.X >= leftX - edge && p.X <= leftX + edge)
                _drag = DragMode.CueStart;
            else if (Math.Abs(p.X - rightX) <= edge)
                _drag = DragMode.CueEnd;
            else
                _drag = DragMode.CueMove;
            _dragLast = p;
            e.Handled = true;
            return;
        }

        // 播放头
        double px = X(PlaybackPosition);
        if (Math.Abs(p.X - px) <= PlayheadHitWidth && p.Y >= RulerHeight)
        {
            _drag = DragMode.Playhead;
            _dragLast = p;
            e.Handled = true;
            return;
        }

        // 空白：seek
        if (p.Y >= RulerHeight)
        {
            SeekRequested?.Invoke(Clamp(TimeAt(p.X)));
            e.Handled = true;
        }
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        var p = e.GetPosition(this);
        switch (_drag)
        {
            case DragMode.Playhead:
            {
                var t = Clamp(TimeAt(p.X));
                SeekRequested?.Invoke(t);
                e.Handled = true;
                break;
            }
            case DragMode.Pan:
            {
                _viewStart = _viewStartAtDrag - TimeSpan.FromSeconds((p.X - _dragLast.X) / _pps);
                ClampView();
                InvalidateVisual();
                e.Handled = true;
                break;
            }
            case DragMode.CueMove:
            case DragMode.CueStart:
            case DragMode.CueEnd:
            {
                if (_dragCue == null) break;
                var dt = TimeAt(p.X) - TimeAt(_dragLast.X);
                switch (_drag)
                {
                    case DragMode.CueMove:
                    {
                        var s = _dragStartTime + dt;
                        var en = _dragEndTime + dt;
                        if (s < TimeSpan.Zero) { en -= s; s = TimeSpan.Zero; }
                        _dragCue.Start = s;
                        _dragCue.End = en;
                        break;
                    }
                    case DragMode.CueStart:
                        _dragCue.Start = _dragStartTime + dt;
                        if (_dragCue.Start < TimeSpan.Zero) _dragCue.Start = TimeSpan.Zero;
                        if (_dragCue.Start > _dragCue.End) _dragCue.Start = _dragCue.End;
                        break;
                    case DragMode.CueEnd:
                        _dragCue.End = _dragEndTime + dt;
                        if (_dragCue.End < _dragCue.Start) _dragCue.End = _dragCue.Start;
                        break;
                }
                ClampView();
                InvalidateVisual();
                CueTimingChanged?.Invoke(_dragCue);
                e.Handled = true;
                break;
            }
            case DragMode.None:
                UpdateHoverCursor(p);
                break;
        }
    }

    protected override void OnMouseUp(MouseButtonEventArgs e)
    {
        if (_drag != DragMode.None)
        {
            _drag = DragMode.None;
            _dragCue = null;
            Cursor = Cursors.Arrow;
            e.Handled = true;
        }
    }

    private void UpdateHoverCursor(Point p)
    {
        var cue = HitTestCue(p.X, p.Y);
        if (cue != null)
        {
            double leftX = X(cue.Start), rightX = X(cue.End);
            Cursor = (Math.Abs(p.X - leftX) <= 5 || Math.Abs(p.X - rightX) <= 5)
                ? Cursors.SizeWE
                : Cursors.Hand;
        }
        else if (p.Y >= WaveTop && Math.Abs(p.X - X(PlaybackPosition)) <= PlayheadHitWidth)
            Cursor = Cursors.SizeWE;
        else
            Cursor = Cursors.Arrow;
    }

    private SubtitleCue? HitTestCue(double x, double y)
    {
        if (Cues == null || y < RulerHeight || y > RulerHeight + CueLaneHeight) return null;
        var t = TimeAt(x);
        for (int i = Cues.Count - 1; i >= 0; i--) // 后画的在上层，逆序命中
        {
            var c = Cues[i];
            if (t >= c.Start && t <= c.End) return c;
        }
        return null;
    }

    public void FitAll()
    {
        var dur = MediaDuration > TimeSpan.Zero ? MediaDuration : (Cues?.Count > 0 ? Cues[^1].End : TimeSpan.FromMinutes(1));
        double duration = Math.Max(dur.TotalSeconds, 1);
        _pps = Math.Clamp((ActualWidth - 20) / duration, 0.1, 4000);
        _viewStart = TimeSpan.Zero;
        ClampView();
        InvalidateVisual();
    }

    /// <summary>确保时间点可见；在视口外则居中滚动（播放跟随用）。</summary>
    public void EnsureVisible(TimeSpan t)
    {
        double x = X(t);
        if (x >= 8 && x <= ActualWidth - 8) return;
        _viewStart = t - TimeSpan.FromSeconds(Math.Max(ActualWidth, 1) / 2 / _pps);
        ClampView();
        InvalidateVisual();
    }

    private TimeSpan Clamp(TimeSpan t)
    {
        double maxSec = Math.Max(MediaDuration.TotalSeconds, 0);
        return TimeSpan.FromSeconds(Math.Clamp(t.TotalSeconds, 0, maxSec > 0 ? maxSec : t.TotalSeconds));
    }

    private void ClampView()
    {
        double duration = Math.Max(MediaDuration.TotalSeconds,
            Cues != null && Cues.Count > 0 ? Cues[^1].End.TotalSeconds : 1);
        double viewWidth = ActualWidth / _pps;
        if (viewWidth >= duration)
        {
            _viewStart = TimeSpan.Zero;
            return;
        }
        double maxStart = duration - viewWidth;
        _viewStart = TimeSpan.FromSeconds(Math.Clamp(_viewStart.TotalSeconds, 0, maxStart));
    }

    // ---- 绘制 ----
    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, h = ActualHeight;
        if (w <= 0 || h <= 0) return;

        dc.DrawRectangle(new SolidColorBrush(Color.FromRgb(0x14, 0x16, 0x1C)), null, new Rect(0, 0, w, h));

        DrawWaveform(dc);
        DrawCueLane(dc);
        DrawGrid(dc);
        DrawCues(dc);
        DrawPlayhead(dc);
        DrawRuler(dc);
    }

    private void DrawWaveform(DrawingContext dc)
    {
        if (Waveform == null) return;
        double top = WaveTop, bottom = WaveBottom;
        double midY = (top + bottom) / 2;
        var geo = new StreamGeometry();
        using (var ctx = geo.Open())
        {
            double centerY = midY;
            double amp = (bottom - top) / 2 - 1;
            for (double x = 0; x < ActualWidth; x += 1)
            {
                var t = TimeAt(x);
                if (t < TimeSpan.Zero || t.TotalSeconds >= Waveform.DurationSeconds) break;
                long b0 = Waveform.TimeToBin(t);
                long b1 = Waveform.TimeToBin(t + TimeSpan.FromSeconds(1.0 / _pps)) + 1;
                var (min, max) = Waveform.Range(b0, b1);
                float n = Waveform.GlobalMax;
                double y1 = centerY - (max / n) * amp;
                double y2 = centerY - (min / n) * amp;
                if (y2 - y1 < 1) y2 = y1 + 1;
                ctx.BeginFigure(new Point(x, y1), false, false);
                ctx.LineTo(new Point(x, y2), true, false);
            }
        }
        var brush = new SolidColorBrush(Color.FromRgb(0x3D, 0xB9, 0x8F)); // 波形绿
        dc.DrawGeometry(brush, null, geo);
    }

    private void DrawCueLane(DrawingContext dc)
    {
        var rect = new Rect(0, RulerHeight, ActualWidth, CueLaneHeight);
        dc.DrawRectangle(new SolidColorBrush(Color.FromRgb(0x1D, 0x20, 0x29)), null, rect);
        dc.DrawLine(new Pen(new SolidColorBrush(Color.FromRgb(0x2E, 0x33, 0x3F)), 1),
            new Point(0, RulerHeight), new Point(ActualWidth, RulerHeight));
        dc.DrawLine(new Pen(new SolidColorBrush(Color.FromRgb(0x2E, 0x33, 0x3F)), 1),
            new Point(0, RulerHeight + CueLaneHeight), new Point(ActualWidth, RulerHeight + CueLaneHeight));
    }

    private void DrawGrid(DrawingContext dc)
    {
        var (step, _) = PickTickStep();
        var minorPen = new Pen(new SolidColorBrush(Color.FromArgb(40, 0xFF, 0xFF, 0xFF)), 1);
        var t0 = _viewStart;
        double startSec = Math.Floor(t0.TotalSeconds / step.TotalSeconds) * step.TotalSeconds;
        for (double s = startSec; s < t0.TotalSeconds + ActualWidth / _pps; s += step.TotalSeconds)
        {
            if (s < 0) continue;
            double x = X(TimeSpan.FromSeconds(s));
            dc.DrawLine(minorPen, new Point(x, RulerHeight), new Point(x, ActualHeight));
        }
    }

    private void DrawCues(DrawingContext dc)
    {
        if (Cues == null) return;
        double laneTop = RulerHeight + 1;
        double laneHeight = CueLaneHeight - 2;
        var selBrush = new SolidColorBrush(Color.FromRgb(0x2F, 0x6F, 0xED));
        var curBrush = new SolidColorBrush(Color.FromRgb(0xD9, 0x9A, 0x2B));
        var normalBrush = new SolidColorBrush(Color.FromRgb(0x3A, 0x3F, 0x4C));
        var selBorder = new Pen(new SolidColorBrush(Color.FromRgb(0x6B, 0x9B, 0xFF)), 1);
        var normalBorder = new Pen(new SolidColorBrush(Color.FromRgb(0x4A, 0x50, 0x60)), 0.6);
        var textBrush = new SolidColorBrush(Color.FromRgb(0xE8, 0xEB, 0xF0));

        foreach (var cue in Cues)
        {
            double x1 = X(cue.Start), x2 = X(cue.End);
            if (x2 < 0 || x1 > ActualWidth) continue; // 视口外
            bool selected = ReferenceEquals(cue, SelectedCue);
            bool current = ReferenceEquals(cue, CurrentCue);
            var rect = new Rect(x1, laneTop, Math.Max(x2 - x1, 1.5), laneHeight);
            dc.DrawRoundedRectangle(selected ? selBrush : (current ? curBrush : normalBrush), null, rect, 3, 3);
            if (selected) dc.DrawRoundedRectangle(null, selBorder, rect, 3, 3);
            if (x2 - x1 > 14)
            {
                var ft = new FormattedText(
                    cue.Text.Replace('\n', ' '),
                    System.Globalization.CultureInfo.CurrentCulture,
                    FlowDirection.LeftToRight,
                    new Typeface("Segoe UI"), 11, textBrush, VisualTreeHelper.GetDpi(this).PixelsPerDip);
                ft.MaxTextWidth = Math.Max(x2 - x1 - 8, 4);
                ft.MaxTextHeight = laneHeight - 4;
                ft.Trimming = TextTrimming.CharacterEllipsis;
                dc.DrawText(ft, new Point(x1 + 4, laneTop + 2));
            }
        }
    }

    private void DrawPlayhead(DrawingContext dc)
    {
        double x = X(PlaybackPosition);
        if (x < -10 || x > ActualWidth + 10) return;
        var pen = new Pen(new SolidColorBrush(Color.FromRgb(0xE8, 0x5A, 0x5A)), 1.2);
        dc.DrawLine(pen, new Point(x, RulerHeight), new Point(x, ActualHeight));
        // 顶部三角
        var tri = new StreamGeometry();
        using (var ctx = tri.Open())
        {
            ctx.BeginFigure(new Point(x - 5, RulerHeight), true, true);
            ctx.LineTo(new Point(x + 5, RulerHeight), true, false);
            ctx.LineTo(new Point(x, RulerHeight - 6), true, false);
        }
        dc.DrawGeometry(new SolidColorBrush(Color.FromRgb(0xE8, 0x5A, 0x5A)), null, tri);
    }

    private void DrawRuler(DrawingContext dc)
    {
        var (step, fracDigits) = PickTickStep();
        var majorPen = new Pen(new SolidColorBrush(Color.FromArgb(110, 0xFF, 0xFF, 0xFF)), 1);
        var textBrush = new SolidColorBrush(Color.FromArgb(200, 0xD0, 0xD6, 0xE0));
        var typeface = new Typeface("Segoe UI");
        double dpi = VisualTreeHelper.GetDpi(this).PixelsPerDip;

        double startSec = Math.Floor(_viewStart.TotalSeconds / step.TotalSeconds) * step.TotalSeconds;
        for (double s = startSec; s <= _viewStart.TotalSeconds + ActualWidth / _pps; s += step.TotalSeconds)
        {
            if (s < 0) continue;
            double x = X(TimeSpan.FromSeconds(s));
            dc.DrawLine(majorPen, new Point(x, RulerHeight - 8), new Point(x, RulerHeight));
            var ft = new FormattedText(FormatTick(s, step), System.Globalization.CultureInfo.CurrentCulture,
                FlowDirection.LeftToRight, typeface, 10, textBrush, dpi);
            dc.DrawText(ft, new Point(x + 3, 2));
        }
    }

    private static string FormatTick(double seconds, TimeSpan step)
    {
        var t = TimeSpan.FromSeconds(seconds);
        if (t.Hours > 0)
            return $"{(int)t.TotalHours}:{t.Minutes:00}:{t.Seconds:00}";
        if (step.TotalSeconds >= 1)
            return $"{t.Minutes}:{t.Seconds:00}";
        // 毫秒刻度：按步长决定小数位
        int frac = step.TotalMilliseconds < 10 ? 3 : (step.TotalMilliseconds < 100 ? 2 : 1);
        return $"{t.Minutes}:{t.Seconds:00}.{t.Milliseconds.ToString().PadLeft(3, '0').Substring(0, frac)}";
    }

    /// <summary>选标尺刻度步长：目标间隔 ≥ 70px。</summary>
    private (TimeSpan Step, int FracDigits) PickTickStep()
    {
        double[] stepsMs =
        {
            1, 2, 5, 10, 20, 50, 100, 200, 500,
            1000, 2000, 5000, 10000, 15000, 30000,
            60000, 120000, 300000, 600000, 1200000, 3600000
        };
        double targetPx = 70;
        foreach (var ms in stepsMs)
        {
            if (ms / 1000.0 * _pps >= targetPx)
                return (TimeSpan.FromMilliseconds(ms), ms < 1000 ? 3 : 0);
        }
        return (TimeSpan.FromHours(1), 0);
    }
}
