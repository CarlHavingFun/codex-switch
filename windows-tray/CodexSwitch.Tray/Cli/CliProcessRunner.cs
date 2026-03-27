using System.Diagnostics;

namespace CodexSwitch.Tray.Cli;

public sealed record CliProcessResult(
    int ExitCode,
    string StandardOutput,
    string StandardError);

public sealed record CodexSwitchCliSettings(
    string Command,
    string? WorkingDirectory,
    TimeSpan Timeout)
{
    public static CodexSwitchCliSettings CreateDefault()
    {
        var configuredCommand = Environment.GetEnvironmentVariable("CODEX_SWITCH_TRAY_COMMAND");
        var configuredWorkingDirectory = Environment.GetEnvironmentVariable("CODEX_SWITCH_TRAY_WORKDIR");

        return new CodexSwitchCliSettings(
            string.IsNullOrWhiteSpace(configuredCommand) ? "codex-switch.cmd" : configuredCommand.Trim(),
            string.IsNullOrWhiteSpace(configuredWorkingDirectory) ? null : configuredWorkingDirectory.Trim(),
            TimeSpan.FromMinutes(5));
    }
}

public interface ICliProcessRunner
{
    Task<CliProcessResult> RunAsync(
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken = default);
}

public sealed class CliProcessRunner : ICliProcessRunner
{
    private readonly CodexSwitchCliSettings _settings;

    public CliProcessRunner(CodexSwitchCliSettings settings)
    {
        _settings = settings;
    }

    public async Task<CliProcessResult> RunAsync(
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken = default)
    {
        using var process = new Process
        {
            StartInfo = CreateStartInfo(arguments),
        };
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(_settings.Timeout);

        process.Start();

        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        Task<string> stderrTask = process.StandardError.ReadToEndAsync();
        Task waitTask = process.WaitForExitAsync(timeoutCts.Token);

        await Task.WhenAll(stdoutTask, stderrTask, waitTask).ConfigureAwait(false);

        return new CliProcessResult(
            process.ExitCode,
            (await stdoutTask.ConfigureAwait(false)).Trim(),
            (await stderrTask.ConfigureAwait(false)).Trim());
    }

    private ProcessStartInfo CreateStartInfo(IReadOnlyList<string> arguments)
    {
        string commandLine = BuildCommandLine(arguments);
        var startInfo = new ProcessStartInfo
        {
            FileName = Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe",
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = _settings.WorkingDirectory ?? Environment.CurrentDirectory,
        };

        startInfo.ArgumentList.Add("/d");
        startInfo.ArgumentList.Add("/s");
        startInfo.ArgumentList.Add("/c");
        startInfo.ArgumentList.Add(commandLine);

        return startInfo;
    }

    private string BuildCommandLine(IReadOnlyList<string> arguments)
    {
        var parts = new List<string> { QuoteForCmd(_settings.Command) };
        parts.AddRange(arguments.Select(QuoteForCmd));
        return string.Join(" ", parts);
    }

    internal static string QuoteForCmd(string value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return "\"\"";
        }

        bool requiresQuoting = value.Any(character => char.IsWhiteSpace(character) || character == '"');
        if (!requiresQuoting)
        {
            return value;
        }

        return $"\"{value.Replace("\"", "\"\"", StringComparison.Ordinal)}\"";
    }
}
