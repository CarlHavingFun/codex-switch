using System.Text.Json;
using CodexSwitch.Tray.Models;

namespace CodexSwitch.Tray.Cli;

public sealed class CodexSwitchCliException : Exception
{
    public CodexSwitchCliException(string message, int exitCode, string standardError)
        : base(message)
    {
        ExitCode = exitCode;
        StandardError = standardError;
    }

    public int ExitCode { get; }

    public string StandardError { get; }
}

public sealed class CodexSwitchCliClient
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly ICliProcessRunner _runner;

    public CodexSwitchCliClient(ICliProcessRunner runner)
    {
        _runner = runner;
    }

    public Task<IReadOnlyList<ManagedProfileDto>> ListProfilesAsync(CancellationToken cancellationToken = default) =>
        RunJsonAsync<IReadOnlyList<ManagedProfileDto>>(new[] { "list", "--json" }, cancellationToken);

    public Task<IReadOnlyList<ProfileStatusDto>> GetAllStatusesAsync(CancellationToken cancellationToken = default) =>
        RunJsonAsync<IReadOnlyList<ProfileStatusDto>>(new[] { "status", "--all", "--json" }, cancellationToken);

    public Task<ManagedProfileDto> UseProfileAsync(string displayName, CancellationToken cancellationToken = default) =>
        RunJsonAsync<ManagedProfileDto>(new[] { "use", displayName, "--json" }, cancellationToken);

    public Task<ManagedProfileDto> LoginAsync(CancellationToken cancellationToken = default) =>
        RunJsonAsync<ManagedProfileDto>(new[] { "login", "--json" }, cancellationToken);

    public Task<ManagedProfileDto> ImportCurrentAsync(CancellationToken cancellationToken = default) =>
        RunJsonAsync<ManagedProfileDto>(new[] { "import-current", "--json" }, cancellationToken);

    public Task<SyncCurrentResultDto> SyncCurrentAsync(CancellationToken cancellationToken = default) =>
        RunJsonAsync<SyncCurrentResultDto>(new[] { "sync-current", "--json" }, cancellationToken);

    public Task<DesktopStatusDto> GetDesktopStatusAsync(CancellationToken cancellationToken = default) =>
        RunJsonAsync<DesktopStatusDto>(new[] { "desktop", "status", "--json" }, cancellationToken);

    public Task<DesktopStatusDto> LaunchDesktopAsync(CancellationToken cancellationToken = default) =>
        RunJsonAsync<DesktopStatusDto>(new[] { "desktop", "launch", "--json" }, cancellationToken);

    public Task<DesktopStatusDto> SwitchDesktopAsync(string displayName, CancellationToken cancellationToken = default) =>
        RunJsonAsync<DesktopStatusDto>(new[] { "desktop", "switch", displayName, "--json" }, cancellationToken);

    private async Task<T> RunJsonAsync<T>(
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken)
    {
        CliProcessResult result = await _runner.RunAsync(arguments, cancellationToken).ConfigureAwait(false);
        if (result.ExitCode != 0)
        {
            throw new CodexSwitchCliException(
                $"codex-switch exited with code {result.ExitCode}.",
                result.ExitCode,
                result.StandardError);
        }

        T? payload = JsonSerializer.Deserialize<T>(result.StandardOutput, JsonOptions);
        if (payload is null)
        {
            throw new InvalidOperationException("codex-switch returned empty JSON output.");
        }

        return payload;
    }
}
