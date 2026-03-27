using System.Diagnostics;
using System.Drawing;
using System.Threading;
using Timer = System.Windows.Forms.Timer;
using CodexSwitch.Tray.Cli;
using CodexSwitch.Tray.Models;
using CodexSwitch.Tray.Presentation;

namespace CodexSwitch.Tray;

internal sealed class TrayApplicationContext : ApplicationContext
{
    private const int RefreshIntervalMs = 5 * 60 * 1000;
    private const int AuthDebounceMs = 1000;

    private readonly CodexSwitchCliClient _cliClient;
    private readonly ContextMenuStrip _menu;
    private readonly NotifyIcon _notifyIcon;
    private readonly Timer _refreshTimer;
    private readonly Timer _startupTimer;
    private readonly Timer _authDebounceTimer;
    private readonly FileSystemWatcher _authWatcher;
    private readonly SemaphoreSlim _refreshGate = new(1, 1);

    private IReadOnlyList<ManagedProfileDto> _profiles = Array.Empty<ManagedProfileDto>();
    private IReadOnlyDictionary<string, ProfileStatusDto> _statusesByProfileId =
        new Dictionary<string, ProfileStatusDto>();

    public TrayApplicationContext(CodexSwitchCliClient cliClient)
    {
        _cliClient = cliClient;
        _menu = new ContextMenuStrip();
        _notifyIcon = new NotifyIcon
        {
            Text = "codex-switch",
            Icon = SystemIcons.Application,
            Visible = true,
            ContextMenuStrip = _menu,
        };
        _notifyIcon.DoubleClick += async (_, _) => await RefreshSnapshotAsync().ConfigureAwait(true);

        BuildPlaceholderMenu("Loading codex-switch profiles...");

        _refreshTimer = new Timer { Interval = RefreshIntervalMs };
        _refreshTimer.Tick += async (_, _) => await RefreshSnapshotAsync().ConfigureAwait(true);
        _refreshTimer.Start();

        _authDebounceTimer = new Timer { Interval = AuthDebounceMs };
        _authDebounceTimer.Tick += async (_, _) =>
        {
            _authDebounceTimer.Stop();
            await SyncAndRefreshAsync(showNotification: true).ConfigureAwait(true);
        };

        _startupTimer = new Timer { Interval = 200 };
        _startupTimer.Tick += async (_, _) =>
        {
            _startupTimer.Stop();
            await SyncAndRefreshAsync(showNotification: false).ConfigureAwait(true);
        };
        _startupTimer.Start();

        _authWatcher = CreateAuthWatcher();
    }

    protected override void ExitThreadCore()
    {
        _authWatcher.EnableRaisingEvents = false;
        _authWatcher.Dispose();
        _refreshTimer.Stop();
        _refreshTimer.Dispose();
        _authDebounceTimer.Stop();
        _authDebounceTimer.Dispose();
        _startupTimer.Stop();
        _startupTimer.Dispose();
        _notifyIcon.Visible = false;
        _notifyIcon.Dispose();
        _menu.Dispose();
        _refreshGate.Dispose();

        base.ExitThreadCore();
    }

    private FileSystemWatcher CreateAuthWatcher()
    {
        string codexHome = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".codex");
        Directory.CreateDirectory(codexHome);

        var watcher = new FileSystemWatcher(codexHome, "auth.json")
        {
            NotifyFilter = NotifyFilters.CreationTime
                | NotifyFilters.FileName
                | NotifyFilters.LastWrite
                | NotifyFilters.Size,
            EnableRaisingEvents = true,
        };
        watcher.Changed += OnAuthFileChanged;
        watcher.Created += OnAuthFileChanged;
        watcher.Renamed += OnAuthFileChanged;
        return watcher;
    }

    private void OnAuthFileChanged(object? sender, FileSystemEventArgs eventArgs)
    {
        if (!string.Equals(eventArgs.Name, "auth.json", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        _authDebounceTimer.Stop();
        _authDebounceTimer.Start();
    }

    private async Task SyncAndRefreshAsync(bool showNotification)
    {
        try
        {
            SyncCurrentResultDto syncResult = await _cliClient.SyncCurrentAsync().ConfigureAwait(true);
            await RefreshSnapshotAsync().ConfigureAwait(true);

            if ((syncResult.Action == "created" || syncResult.Action == "switched") &&
                syncResult.Profile is not null &&
                showNotification)
            {
                ShowBalloon(
                    "codex-switch",
                    $"{syncResult.Action}: {syncResult.Profile.DisplayName}",
                    ToolTipIcon.Info);
            }
        }
        catch (Exception exception)
        {
            ShowBalloon("codex-switch", GetErrorMessage(exception), ToolTipIcon.Error);
            BuildPlaceholderMenu("codex-switch failed to refresh");
        }
    }

    private async Task RefreshSnapshotAsync()
    {
        if (!await _refreshGate.WaitAsync(0).ConfigureAwait(true))
        {
            return;
        }

        try
        {
            IReadOnlyList<ManagedProfileDto> profiles =
                await _cliClient.ListProfilesAsync().ConfigureAwait(true);
            IReadOnlyList<ProfileStatusDto> statuses = profiles.Count == 0
                ? Array.Empty<ProfileStatusDto>()
                : await _cliClient.GetAllStatusesAsync().ConfigureAwait(true);

            _profiles = profiles
                .OrderByDescending(profile => profile.IsActive)
                .ThenBy(profile => profile.DisplayName, StringComparer.OrdinalIgnoreCase)
                .ToArray();
            _statusesByProfileId = statuses.ToDictionary(status => status.Profile.Id);
            RebuildMenu();
        }
        catch (Exception exception)
        {
            ShowBalloon("codex-switch", GetErrorMessage(exception), ToolTipIcon.Error);
            BuildPlaceholderMenu("codex-switch failed to refresh");
        }
        finally
        {
            _refreshGate.Release();
        }
    }

    private void RebuildMenu()
    {
        _menu.Items.Clear();

        ManagedProfileDto? activeProfile = _profiles.FirstOrDefault(profile => profile.IsActive);
        _menu.Items.Add(new ToolStripMenuItem(
            ProfileMenuFormatter.FormatActiveSummary(activeProfile, _statusesByProfileId))
        {
            Enabled = false,
        });
        _menu.Items.Add(new ToolStripSeparator());

        if (_profiles.Count == 0)
        {
            _menu.Items.Add(new ToolStripMenuItem("No profiles yet")
            {
                Enabled = false,
            });
        }
        else
        {
            foreach (ManagedProfileDto profile in _profiles)
            {
                _statusesByProfileId.TryGetValue(profile.Id, out ProfileStatusDto? status);
                var item = new ToolStripMenuItem(ProfileMenuFormatter.FormatProfileLabel(profile, status))
                {
                    Checked = profile.IsActive,
                };
                item.Click += async (_, _) => await UseProfileAsync(profile).ConfigureAwait(true);
                _menu.Items.Add(item);
            }
        }

        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(CreateAsyncMenuItem("Refresh now", RefreshSnapshotAsync));
        _menu.Items.Add(CreateAsyncMenuItem("Add Profile", AddProfileAsync));
        _menu.Items.Add(CreateAsyncMenuItem("Import Current Login", ImportCurrentAsync));

        var openFolder = new ToolStripMenuItem("Open Profile Folder")
        {
            Enabled = activeProfile is not null,
        };
        openFolder.Click += (_, _) => OpenProfileFolder(activeProfile);
        _menu.Items.Add(openFolder);

        _menu.Items.Add(new ToolStripSeparator());
        var exitItem = new ToolStripMenuItem("Exit");
        exitItem.Click += (_, _) => ExitThread();
        _menu.Items.Add(exitItem);
    }

    private ToolStripMenuItem CreateAsyncMenuItem(string text, Func<Task> action)
    {
        var item = new ToolStripMenuItem(text);
        item.Click += async (_, _) =>
        {
            try
            {
                await action().ConfigureAwait(true);
            }
            catch (Exception exception)
            {
                ShowBalloon("codex-switch", GetErrorMessage(exception), ToolTipIcon.Error);
            }
        };
        return item;
    }

    private async Task UseProfileAsync(ManagedProfileDto profile)
    {
        await _cliClient.UseProfileAsync(profile.DisplayName).ConfigureAwait(true);
        await RefreshSnapshotAsync().ConfigureAwait(true);
    }

    private async Task AddProfileAsync()
    {
        ManagedProfileDto profile = await _cliClient.LoginAsync().ConfigureAwait(true);
        await RefreshSnapshotAsync().ConfigureAwait(true);
        ShowBalloon("codex-switch", $"Added {profile.DisplayName}", ToolTipIcon.Info);
    }

    private async Task ImportCurrentAsync()
    {
        ManagedProfileDto profile = await _cliClient.ImportCurrentAsync().ConfigureAwait(true);
        await RefreshSnapshotAsync().ConfigureAwait(true);
        ShowBalloon("codex-switch", $"Imported {profile.DisplayName}", ToolTipIcon.Info);
    }

    private void OpenProfileFolder(ManagedProfileDto? activeProfile)
    {
        if (activeProfile is null)
        {
            return;
        }

        string profileFolder = Directory.GetParent(activeProfile.CodexHome)?.FullName ?? activeProfile.CodexHome;
        Process.Start(new ProcessStartInfo
        {
            FileName = "explorer.exe",
            Arguments = $"\"{profileFolder}\"",
            UseShellExecute = true,
        });
    }

    private void BuildPlaceholderMenu(string message)
    {
        _menu.Items.Clear();
        _menu.Items.Add(new ToolStripMenuItem(message)
        {
            Enabled = false,
        });
        _menu.Items.Add(new ToolStripSeparator());
        _menu.Items.Add(CreateAsyncMenuItem("Refresh now", RefreshSnapshotAsync));
        var exitItem = new ToolStripMenuItem("Exit");
        exitItem.Click += (_, _) => ExitThread();
        _menu.Items.Add(exitItem);
    }

    private void ShowBalloon(string title, string message, ToolTipIcon icon)
    {
        _notifyIcon.BalloonTipIcon = icon;
        _notifyIcon.BalloonTipTitle = title;
        _notifyIcon.BalloonTipText = message;
        _notifyIcon.ShowBalloonTip(4000);
    }

    private static string GetErrorMessage(Exception exception) =>
        exception is CodexSwitchCliException cliException && !string.IsNullOrWhiteSpace(cliException.StandardError)
            ? cliException.StandardError
            : exception.Message;
}
