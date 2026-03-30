using System.Text.Json;

namespace CodexSwitch.Tray.Models;

public sealed record ManagedProfileDto(
    string Id,
    string DisplayName,
    string CodexHome,
    string? AuthMode,
    string? AccountId,
    string? PlanType,
    string? WorkspaceLabel,
    string? WorkspaceObserved,
    string? AuthFingerprint,
    string? LastVerifiedAt,
    JsonElement? LastRateLimitSnapshot,
    bool IsActive);

public sealed record AccountDto(
    string? Type,
    string? Email,
    string? PlanType);

public sealed record UsageSummaryDto(
    string UsageKind,
    string? CreditsBalance,
    int? PrimaryUsedPercent,
    int? PrimaryRemainingPercent,
    long? PrimaryResetsAt,
    int? SecondaryUsedPercent,
    int? SecondaryRemainingPercent,
    long? SecondaryResetsAt,
    string? DisplayPlanType);

public sealed record ProfileStatusDto(
    ManagedProfileDto Profile,
    string? LoginStatus,
    AccountDto? Account,
    JsonElement? RateLimits,
    bool? RequiresOpenaiAuth,
    UsageSummaryDto UsageSummary);

public sealed record AuthSummaryDto(
    string? AuthMode,
    string? AccountId,
    string? Email,
    string? WorkspaceTitle);

public sealed record SyncCurrentResultDto(
    string Action,
    ManagedProfileDto? Profile,
    AuthSummaryDto? AuthSummary,
    string? AuthFingerprint,
    string? Reason);

public sealed record DesktopStatusDto(
    bool Managed,
    bool Running,
    int? DesktopPid,
    int? MonitorPid,
    string? ExecutablePath,
    string? SessionHome,
    string? LaunchedAt,
    string? LaunchProfileId,
    string? LastObservedAccountId,
    string? LastObservedProfileId,
    string? LastSyncedAt,
    string? LastError);
