using LibVLCSharp.Shared;

namespace MusicSubtitle.Services;

/// <summary>LibVLC 播放器封装：音视频通吃，时间/时长/速率/音量控制，事件驱动。</summary>
public sealed class PlaybackService : IDisposable
{
    private readonly LibVLC _libVlc;
    private readonly MediaPlayer _player;
    private bool _disposed;

    public PlaybackService()
    {
        Core.Initialize();
        _libVlc = new LibVLC("--no-video-title-show", "--quiet");
        _player = new MediaPlayer(_libVlc)
        {
            EnableHardwareDecoding = true
        };
        _player.TimeChanged += (_, e) => PositionChanged?.Invoke(TimeSpan.FromMilliseconds(e.Time));
        _player.LengthChanged += (_, e) =>
        {
            Duration = TimeSpan.FromMilliseconds(Math.Max(e.Length, 0));
            MediaOpened?.Invoke();
        };
        _player.EndReached += (_, _) =>
        {
            IsPlaying = false;
            EndReached?.Invoke();
        };
        _player.Playing += (_, _) => IsPlaying = true;
        _player.Paused += (_, _) => IsPlaying = false;
        _player.Stopped += (_, _) => IsPlaying = false;
    }

    public MediaPlayer Native => _player;

    public event Action<TimeSpan>? PositionChanged;
    public event Action? MediaOpened;
    public event Action? EndReached;

    public TimeSpan Duration { get; private set; } = TimeSpan.Zero;
    public bool IsPlaying { get; private set; }
    public string? CurrentPath { get; private set; }

    public bool HasMedia => CurrentPath != null;

    public void Open(string path)
    {
        using var media = new Media(_libVlc, path, FromType.FromPath);
        _player.Play(media);
        CurrentPath = path;
        Duration = TimeSpan.Zero; // LengthChanged 会重新填充
    }

    public void Play() => _player.Play();
    public void Pause() => _player.Pause();

    public void PlayPause()
    {
        if (_player.IsPlaying) Pause(); else Play();
    }

    public void Stop()
    {
        _player.Stop();
        Duration = TimeSpan.Zero;
        PositionChanged?.Invoke(TimeSpan.Zero);
    }

    public void Seek(TimeSpan t)
    {
        _player.Time = Math.Clamp((long)t.TotalMilliseconds, 0, (long)Duration.TotalMilliseconds);
    }

    /// <summary>相对当前时间跳（逐帧校对用）。</summary>
    public void SeekRelative(TimeSpan delta)
    {
        var target = TimeSpan.FromMilliseconds(_player.Time + delta.TotalMilliseconds);
        Seek(target);
    }

    /// <summary>播放速率 0.25~4.0（校对时慢速听）。</summary>
    public double Rate
    {
        get => _player.Rate;
        set => _player.SetRate((float)Math.Clamp(value, 0.25, 4.0));
    }

    public int Volume
    {
        get => _player.Volume;
        set => _player.Volume = Math.Clamp(value, 0, 200);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _player.Stop();
        _player.Dispose();
        _libVlc.Dispose();
    }
}
