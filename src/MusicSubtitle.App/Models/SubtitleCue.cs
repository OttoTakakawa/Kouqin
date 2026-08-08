using System.ComponentModel;
using System.Runtime.CompilerServices;

namespace MusicSubtitle.Models;

/// <summary>单条字幕：时间段 + 文本。实现 INPC 以便时间轴拖拽后列表即时刷新。</summary>
public sealed class SubtitleCue : INotifyPropertyChanged
{
    private TimeSpan _start;
    private TimeSpan _end;
    private string _text = "";

    public event PropertyChangedEventHandler? PropertyChanged;

    public TimeSpan Start
    {
        get => _start;
        set { if (_start == value) return; _start = value; OnChanged(); }
    }

    public TimeSpan End
    {
        get => _end;
        set { if (_end == value) return; _end = value; OnChanged(); }
    }

    public string Text
    {
        get => _text;
        set { if (_text == value) return; _text = value; OnChanged(); }
    }

    public TimeSpan Duration => End - Start;

    public void Shift(TimeSpan delta)
    {
        Start += delta;
        End += delta;
        if (Start < TimeSpan.Zero) Start = TimeSpan.Zero;
        if (End < Start) End = Start;
    }

    /// <summary>对 Start/End 应用线性映射（点同步用）。</summary>
    public void Remap(Func<TimeSpan, TimeSpan> f)
    {
        Start = f(Start);
        End = f(End);
        if (Start < TimeSpan.Zero) Start = TimeSpan.Zero;
        if (End < Start) End = Start;
    }

    public bool Contains(TimeSpan t) => t >= Start && t < End;

    private void OnChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
