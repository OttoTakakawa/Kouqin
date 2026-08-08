using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Windows;
using System.Windows.Threading;
using MusicSubtitle.Models;
using MusicSubtitle.Services;

namespace MusicSubtitle.ViewModels;

/// <summary>
/// 主视图模型：媒体 + 字幕的加载/保存、播放控制、校对操作（微调/平移/点同步）。
/// 事件全部回 UI 线程（LibVLC 回调在内部线程）。
/// </summary>
public sealed class MainViewModel : INotifyPropertyChanged
{
    private readonly SynchronizationContext? _ui;
    private SubtitleDocument? _document;
    private TimeSpan _playbackPosition;
    private TimeSpan _duration;
    private bool _isPlaying;
    private double _rate = 1.0;
    private SubtitleCue? _selectedCue;
    private SubtitleCue? _currentCue;
    private string _mediaTitle = "";
    private string _subtitleTitle = "";
    private string _statusText = "就绪";

    public MainViewModel()
    {
        _ui = SynchronizationContext.Current;
        Player = new PlaybackService();
        Player.PositionChanged += t => Post(() => PlaybackPosition = t);
        Player.MediaOpened += () => Post(() => Duration = Player.Duration);
        Player.EndReached += () => Post(() => IsPlaying = false);

        OpenMediaCommand = new RelayCommand(() => PickAndOpenMedia());
        OpenSubtitleCommand = new RelayCommand(() => PickAndOpenSubtitle());
        SaveCommand = new RelayCommand(Save, () => _document != null);
        SaveAsCommand = new RelayCommand(SaveAs, () => _document != null);
        PlayPauseCommand = new RelayCommand(PlayPause, () => Player.HasMedia);
        StopCommand = new RelayCommand(() => Player.Stop(), () => Player.HasMedia);
        ShiftAllBackCommand = new RelayCommand(() => ShiftAll(-500), () => _document != null);
        ShiftAllForwardCommand = new RelayCommand(() => ShiftAll(500), () => _document != null);
        PointSyncCommand = new RelayCommand(PointSync, () => _document != null && _document.Count >= 2);
        NudgeStartBackCommand = new RelayCommand(() => NudgeStart(-100));
        NudgeStartForwardCommand = new RelayCommand(() => NudgeStart(100));
        NudgeStartBackBigCommand = new RelayCommand(() => NudgeStart(-500));
        NudgeStartForwardBigCommand = new RelayCommand(() => NudgeStart(500));
        NudgeEndBackCommand = new RelayCommand(() => NudgeEnd(-100));
        NudgeEndForwardCommand = new RelayCommand(() => NudgeEnd(100));
        PreviousCueCommand = new RelayCommand(() => MoveSelection(-1));
        NextCueCommand = new RelayCommand(() => MoveSelection(1));
    }

    public PlaybackService Player { get; }

    // ---- 命令 ----
    public RelayCommand OpenMediaCommand { get; }
    public RelayCommand OpenSubtitleCommand { get; }
    public RelayCommand SaveCommand { get; }
    public RelayCommand SaveAsCommand { get; }
    public RelayCommand PlayPauseCommand { get; }
    public RelayCommand StopCommand { get; }
    public RelayCommand ShiftAllBackCommand { get; }
    public RelayCommand ShiftAllForwardCommand { get; }
    public RelayCommand PointSyncCommand { get; }
    public RelayCommand NudgeStartBackCommand { get; }
    public RelayCommand NudgeStartForwardCommand { get; }
    public RelayCommand NudgeStartBackBigCommand { get; }
    public RelayCommand NudgeStartForwardBigCommand { get; }
    public RelayCommand NudgeEndBackCommand { get; }
    public RelayCommand NudgeEndForwardCommand { get; }
    public RelayCommand PreviousCueCommand { get; }
    public RelayCommand NextCueCommand { get; }

    // ---- 绑定属性 ----
    public SubtitleDocument? Document => _document;
    public TimeSpan PlaybackPosition
    {
        get => _playbackPosition;
        private set
        {
            if (_playbackPosition == value) return;
            _playbackPosition = value;
            OnChanged();
            UpdateCurrentCue();
        }
    }

    public TimeSpan Duration
    {
        get => _duration;
        private set { if (_duration == value) return; _duration = value; OnChanged(); }
    }

    public bool IsPlaying
    {
        get => _isPlaying;
        private set { if (_isPlaying == value) return; _isPlaying = value; OnChanged(); }
    }

    public double Rate
    {
        get => _rate;
        set
        {
            if (Math.Abs(_rate - value) < 0.01) return;
            _rate = value;
            Player.Rate = value;
            OnChanged();
        }
    }

    public SubtitleCue? SelectedCue
    {
        get => _selectedCue;
        set { if (ReferenceEquals(_selectedCue, value)) return; _selectedCue = value; OnChanged(); }
    }

    public SubtitleCue? CurrentCue
    {
        get => _currentCue;
        private set { if (ReferenceEquals(_currentCue, value)) return; _currentCue = value; OnChanged(); }
    }

    public string MediaTitle { get => _mediaTitle; private set { _mediaTitle = value; OnChanged(); } }
    public string SubtitleTitle { get => _subtitleTitle; private set { _subtitleTitle = value; OnChanged(); } }
    public string StatusText { get => _statusText; set { _statusText = value; OnChanged(); } }

    // ---- 加载 ----
    public void PickAndOpenMedia()
    {
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Title = "打开媒体（视频/音乐）",
            Filter = "媒体文件|*.mp4;*.mkv;*.avi;*.mov;*.wmv;*.flv;*.webm;*.mp3;*.wav;*.flac;*.aiff;*.m4a;*.aac;*.ogg|所有文件|*.*"
        };
        if (dlg.ShowDialog() == true) OpenMedia(dlg.FileName);
    }

    public void PickAndOpenSubtitle()
    {
        var dlg = new Microsoft.Win32.OpenFileDialog
        {
            Title = "打开字幕",
            Filter = "SRT 字幕|*.srt|所有文件|*.*"
        };
        if (dlg.ShowDialog() == true) OpenSubtitle(dlg.FileName);
    }

    public void OpenMedia(string path)
    {
        if (!File.Exists(path)) return;
        try
        {
            Player.Open(path);
            MediaTitle = Path.GetFileName(path);
            StatusText = $"已加载媒体：{path}";
            // 自动探测同名 srt
            var srt = Path.ChangeExtension(path, ".srt");
            if (File.Exists(srt)) OpenSubtitle(srt, quiet: true);
            LoadWaveform(path);
        }
        catch (Exception ex)
        {
            StatusText = $"打开媒体失败：{ex.Message}";
        }
    }

    public void OpenSubtitle(string path, bool quiet = false)
    {
        if (!File.Exists(path)) return;
        try
        {
            _document = SrtParser.Load(path);
            SubtitleTitle = $"{Path.GetFileName(path)}（{_document.SourceEncodingName}）";
            StatusText = $"已加载字幕：{path}（{_document.Count} 条，源编码 {_document.SourceEncodingName}）";
            foreach (var c in _document.Cues) c.PropertyChanged += (_, e) => { if (e.PropertyName == nameof(SubtitleCue.Start) || e.PropertyName == nameof(SubtitleCue.End)) StatusText = "未保存的更改"; };
            RaiseDocumentChanged();
        }
        catch (Exception ex)
        {
            StatusText = $"打开字幕失败：{ex.Message}";
            if (!quiet) MessageBox.Show($"无法读取字幕文件：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void RaiseDocumentChanged()
    {
        OnChanged(nameof(Document));
        SaveCommand.RaiseCanExecuteChanged();
        SaveAsCommand.RaiseCanExecuteChanged();
        ShiftAllBackCommand.RaiseCanExecuteChanged();
        ShiftAllForwardCommand.RaiseCanExecuteChanged();
        PointSyncCommand.RaiseCanExecuteChanged();
    }

    private async void LoadWaveform(string mediaPath)
    {
        // 只有 NAudio 能解码的音频格式才有波形；其他（视频）时间轴照常
        string ext = Path.GetExtension(mediaPath).ToLowerInvariant();
        bool audio = ext is ".wav" or ".mp3" or ".flac" or ".aiff" or ".aif" or ".ogg";
        if (!audio) return;
        StatusText = "正在提取波形…";
        try
        {
            var waveform = await Task.Run(() => WaveformBuilder.Build(mediaPath));
            Waveform = waveform;
            StatusText = $"{Path.GetFileName(mediaPath)}：波形就绪（{waveform.DurationSeconds:0.0}s）";
        }
        catch (Exception ex)
        {
            StatusText = $"波形提取失败：{ex.Message}";
        }
    }

    private Services.WaveformData? _waveform;

    public Services.WaveformData? Waveform
    {
        get => _waveform;
        private set { _waveform = value; OnChanged(); }
    }

    // ---- 播放控制 ----
    public void PlayPause()
    {
        if (!Player.HasMedia) return;
        if (Player.IsPlaying) Player.Pause();
        else
        {
            // 播完停在末尾时，从头开始
            if (_playbackPosition >= Duration && Duration > TimeSpan.Zero) Player.Seek(TimeSpan.Zero);
            Player.Play();
        }
    }

    public void SeekTo(TimeSpan t) => Player.Seek(t);

    /// <summary>相对跳（逐帧校对）。</summary>
    public void SeekRelative(TimeSpan delta) => Player.SeekRelative(delta);

    // ---- 校对操作 ----
    private SubtitleCue? TargetCue => SelectedCue ?? CurrentCue;

    public void NudgeStart(int ms)
    {
        var cue = TargetCue;
        if (cue == null) return;
        cue.Start = TimeSpan.FromMilliseconds(Math.Max(0, cue.Start.TotalMilliseconds + ms));
        if (cue.End < cue.Start) cue.End = cue.Start;
        StatusText = $"起点 {SrtParser.FormatTime(cue.Start)}";
    }

    public void NudgeEnd(int ms)
    {
        var cue = TargetCue;
        if (cue == null) return;
        cue.End = TimeSpan.FromMilliseconds(Math.Max(0, cue.End.TotalMilliseconds + ms));
        if (cue.End < cue.Start) cue.End = cue.Start;
        StatusText = $"终点 {SrtParser.FormatTime(cue.End)}";
    }

    public void ShiftAll(int ms)
    {
        if (_document == null) return;
        _document.ShiftAll(TimeSpan.FromMilliseconds(ms));
        StatusText = $"整体平移 {ms:+0;-0}ms";
    }

    public void MoveSelection(int direction)
    {
        if (_document == null || _document.Count == 0) return;
        int idx = _document.Cues.IndexOf(TargetCue ?? _document.Cues[0]);
        idx = Math.Clamp(idx + direction, 0, _document.Count - 1);
        SelectedCue = _document.Cues[idx];
        Player.Seek(SelectedCue.Start);
    }

    private void UpdateCurrentCue()
    {
        var c = _document?.FindAt(_playbackPosition);
        CurrentCue = c;
    }

    /// <summary>点同步：弹对话框选两锚点并填目标时间。</summary>
    private void PointSync()
    {
        if (_document == null || _document.Count < 2) return;
        var win = new Views.PointSyncWindow(_document, Player, _playbackPosition);
        if (win.ShowDialog() == true)
        {
            _document.PointSync(win.AnchorA, win.TargetA, win.AnchorB, win.TargetB);
            StatusText = $"点同步完成：{SrtParser.FormatTime(win.AnchorA.Start)}→{SrtParser.FormatTime(win.TargetA)}，{SrtParser.FormatTime(win.AnchorB.Start)}→{SrtParser.FormatTime(win.TargetB)}";
        }
    }

    // ---- 保存 ----
    public void Save()
    {
        if (_document == null) return;
        if (string.IsNullOrEmpty(_document.FilePath)) { SaveAs(); return; }
        DoSave(_document.FilePath);
    }

    public void SaveAs()
    {
        if (_document == null) return;
        var dlg = new Microsoft.Win32.SaveFileDialog
        {
            Title = "保存字幕",
            Filter = "SRT 字幕|*.srt",
            DefaultExt = ".srt",
            FileName = _document.FilePath.Length > 0 ? Path.GetFileName(_document.FilePath) : "字幕.srt"
        };
        if (dlg.ShowDialog() == true) DoSave(dlg.FileName);
    }

    private void DoSave(string path)
    {
        try
        {
            SrtParser.Save(_document!, path);
            _document!.FilePath = path;
            SubtitleTitle = $"{Path.GetFileName(path)}（保存为 UTF-8）";
            StatusText = $"已保存：{path}";
        }
        catch (Exception ex)
        {
            StatusText = $"保存失败：{ex.Message}";
            MessageBox.Show($"无法保存字幕：{ex.Message}", "错误", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    // ---- 基础设施 ----
    private void Post(Action a)
    {
        if (_ui != null && SynchronizationContext.Current != _ui) _ui.Post(_ => a(), null);
        else a();
    }

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnChanged([CallerMemberName] string? name = null)
        => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));

    public void Shutdown()
    {
        Player.Dispose();
    }
}
