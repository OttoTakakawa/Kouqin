using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using MusicSubtitle.ViewModels;

namespace MusicSubtitle.Views;

public partial class MainWindow : Window
{
    private readonly MainViewModel _vm;
    private bool _scrubbing;

    /// <summary>设计器用。</summary>
    public MainWindow()
    {
        _vm = null!;
        InitializeComponent();
    }

    public MainWindow(MainViewModel vm) : this()
    {
        _vm = vm;
        DataContext = vm;

        VideoView.MediaPlayer = vm.Player.Native;

        // 时间轴事件 → 播放器/视图模型
        Timeline.SeekRequested += t => _vm.SeekTo(t);
        Timeline.CueSelected += c => _vm.SelectedCue = c;
        Timeline.CueActivated += c =>
        {
            _vm.SeekTo(c.Start);
            if (!_vm.IsPlaying) _vm.PlayPause();
        };
        Timeline.CueTimingChanged += c => _vm.StatusText = $"字幕 {_vm.Document?.Cues.IndexOf(c) + 1}: {System.Text.RegularExpressions.Regex.Replace(c.Text, @"\s+", " ").Truncate(24)}";

        // 视图模型变化 → UI 跟随
        _vm.PropertyChanged += (_, e) =>
        {
            switch (e.PropertyName)
            {
                case nameof(MainViewModel.CurrentCue):
                    UpdateLyric();
                    if (_vm.CurrentCue != null) Timeline.EnsureVisible(_vm.CurrentCue.Start);
                    break;
                case nameof(MainViewModel.IsPlaying):
                    UpdateTitle();
                    break;
                case nameof(MainViewModel.SelectedCue):
                    ScrollSelectionIntoView();
                    break;
            }
        };
        _vm.Player.MediaOpened += () => Dispatcher.BeginInvoke(UpdateTitle);
    }

    private void UpdateLyric()
    {
        var cue = _vm.CurrentCue;
        if (cue == null || string.IsNullOrWhiteSpace(cue.Text))
        {
            LyricHost.Visibility = Visibility.Collapsed;
            return;
        }
        LyricHost.Visibility = Visibility.Visible;
        LyricText.Text = cue.Text;
    }

    private void UpdateTitle()
        => Title = $"MusicSubtitle — 字幕校对" + (_vm.IsPlaying ? "（播放中）" : "");

    private void ScrollSelectionIntoView()
    {
        if (_vm.SelectedCue != null)
            CueList.ScrollIntoView(_vm.SelectedCue);
    }

    private void CueList_MouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (CueList.SelectedItem is not Models.SubtitleCue cue) return;
        _vm.SeekTo(cue.Start);
        if (!_vm.IsPlaying) _vm.PlayPause();
    }

    // ---- 进度条拖动 ----
    private void Progress_PreviewMouseDown(object sender, MouseButtonEventArgs e) => _scrubbing = true;
    private void Progress_PreviewMouseUp(object sender, MouseButtonEventArgs e) => _scrubbing = false;

    private void Progress_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
    {
        if (_scrubbing && DataContext is MainViewModel vm && e.NewValue >= 0)
            vm.SeekTo(System.TimeSpan.FromSeconds(e.NewValue));
    }

    // ---- 快捷键 ----
    protected override void OnKeyDown(KeyEventArgs e)
    {
        // 文本框聚焦且无修饰键：交给文本框（输入用）
        if (Keyboard.FocusedElement is TextBox && e.KeyboardDevice.Modifiers == ModifierKeys.None)
            return;

        var mods = e.KeyboardDevice.Modifiers;
        var vm = DataContext as MainViewModel;
        if (vm == null) { base.OnKeyDown(e); return; }

        switch (e.Key)
        {
            case Key.Space:
                vm.PlayPause();
                e.Handled = true;
                break;
            case Key.Oem4: // [
                if ((mods & ModifierKeys.Alt) != 0) vm.NudgeEnd(-100);
                else if ((mods & ModifierKeys.Shift) != 0) vm.NudgeStart(-500);
                else vm.NudgeStart(-100);
                e.Handled = true;
                break;
            case Key.Oem6: // ]
                if ((mods & ModifierKeys.Alt) != 0) vm.NudgeEnd(100);
                else if ((mods & ModifierKeys.Shift) != 0) vm.NudgeStart(500);
                else vm.NudgeStart(100);
                e.Handled = true;
                break;
            case Key.Left:
                vm.SeekRelative(System.TimeSpan.FromMilliseconds(
                    (mods & ModifierKeys.Shift) != 0 ? -100 : ((mods & ModifierKeys.Control) != 0 ? -5000 : -1000)));
                e.Handled = true;
                break;
            case Key.Right:
                vm.SeekRelative(System.TimeSpan.FromMilliseconds(
                    (mods & ModifierKeys.Shift) != 0 ? 100 : ((mods & ModifierKeys.Control) != 0 ? 5000 : 1000)));
                e.Handled = true;
                break;
            case Key.Up:
                vm.MoveSelection(-1);
                e.Handled = true;
                break;
            case Key.Down:
                vm.MoveSelection(1);
                e.Handled = true;
                break;
            case Key.S when (mods & ModifierKeys.Control) != 0:
                if ((mods & ModifierKeys.Shift) != 0) vm.SaveAs(); else vm.Save();
                e.Handled = true;
                break;
            case Key.P when (mods & ModifierKeys.Control) != 0:
                vm.PointSyncCommand.Execute(null);
                e.Handled = true;
                break;
            case Key.F5:
                Timeline.FitAll();
                e.Handled = true;
                break;
            case Key.Escape:
                if (vm.IsPlaying) { vm.PlayPause(); e.Handled = true; }
                break;
        }
        base.OnKeyDown(e);
    }

    // ---- 拖入文件 ----
    private void Window_Drop(object sender, DragEventArgs e)
    {
        if (!e.Data.GetDataPresent(DataFormats.FileDrop)) return;
        var files = (string[])e.Data.GetData(DataFormats.FileDrop);
        foreach (var path in files.Take(4))
        {
            if (path.EndsWith(".srt", StringComparison.OrdinalIgnoreCase)) _vm.OpenSubtitle(path);
            else _vm.OpenMedia(path);
        }
    }

    protected override void OnClosed(EventArgs e)
    {
        _vm.Shutdown();
        base.OnClosed(e);
    }
}

internal static class StringExt
{
    public static string Truncate(this string s, int max)
        => s.Length <= max ? s : s[..max] + "…";
}

