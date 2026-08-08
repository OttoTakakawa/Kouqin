using System.Globalization;
using System.Windows.Data;

namespace MusicSubtitle.Converters;

/// <summary>TimeSpan → double 秒（Slider 用）。</summary>
public sealed class TimeSpanToSecondsConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture)
        => value is TimeSpan ts ? ts.TotalSeconds : 0.0;

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture)
        => TimeSpan.FromSeconds(value is double d ? d : 0.0);
}
