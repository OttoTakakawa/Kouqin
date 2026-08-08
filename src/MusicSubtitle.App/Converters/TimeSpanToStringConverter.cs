using System.Globalization;
using System.Windows.Data;
using MusicSubtitle.Services;

namespace MusicSubtitle.Converters;

/// <summary>TimeSpan → SRT 时间文本（00:00:01,000）。</summary>
public sealed class TimeSpanToStringConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => value is TimeSpan ts ? SrtParser.FormatTime(ts) : "";

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => throw new NotSupportedException();
}
