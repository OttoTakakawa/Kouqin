using System.Text;
using System.Windows;
using MusicSubtitle.ViewModels;
using MusicSubtitle.Views;

namespace MusicSubtitle.App;

/// <summary>Interaction logic for App.xaml</summary>
public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        // 支持 GBK(936) 等代码页（无 BOM 的中文字幕文件）
        Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);

        base.OnStartup(e);
        var vm = new MainViewModel();
        var window = new MusicSubtitle.Views.MainWindow(vm);
        MainWindow = window;
        window.Show();

        // 命令行参数：打开文件（.srt 或媒体）
        foreach (var arg in e.Args)
        {
            if (arg.EndsWith(".srt", StringComparison.OrdinalIgnoreCase)) vm.OpenSubtitle(arg, quiet: true);
            else vm.OpenMedia(arg);
        }
    }
}
