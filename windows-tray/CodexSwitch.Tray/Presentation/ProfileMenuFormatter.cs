using CodexSwitch.Tray.Models;

namespace CodexSwitch.Tray.Presentation;

public static class ProfileMenuFormatter
{
    public static string FormatWorkspace(ManagedProfileDto profile)
    {
        string? workspaceLabel = Normalize(profile.WorkspaceLabel);
        string? workspaceObserved = Normalize(profile.WorkspaceObserved);

        if (!string.IsNullOrWhiteSpace(workspaceLabel))
        {
            return workspaceLabel;
        }

        return workspaceObserved ?? "unlabeled";
    }

    public static string FormatProfileLabel(ManagedProfileDto profile, ProfileStatusDto? status)
    {
        string authMode = Normalize(profile.AuthMode) ?? "unknown";
        return $"{profile.DisplayName} [{authMode}] {FormatWorkspace(profile)} | {FormatUsage(status)}";
    }

    public static string FormatActiveSummary(
        ManagedProfileDto? activeProfile,
        IReadOnlyDictionary<string, ProfileStatusDto> statusesByProfileId)
    {
        if (activeProfile is null)
        {
            return "Current: no active profile";
        }

        statusesByProfileId.TryGetValue(activeProfile.Id, out ProfileStatusDto? status);
        return $"Current: {activeProfile.DisplayName} | {FormatUsage(status)}";
    }

    private static string FormatUsage(ProfileStatusDto? status)
    {
        if (status is null)
        {
            return "status unavailable";
        }

        UsageSummaryDto summary = status.UsageSummary;
        if (string.Equals(summary.UsageKind, "credits", StringComparison.OrdinalIgnoreCase) &&
            !string.IsNullOrWhiteSpace(summary.CreditsBalance))
        {
            return $"credits {summary.CreditsBalance}{FormatResetSuffix(summary)}";
        }

        if (summary.PrimaryRemainingPercent is not null)
        {
            return $"{summary.PrimaryRemainingPercent}% left{FormatResetSuffix(summary)}";
        }

        return "usage unavailable";
    }

    private static string FormatResetSuffix(UsageSummaryDto summary)
    {
        long? resetTimestamp = summary.PrimaryResetsAt ?? summary.SecondaryResetsAt;
        return resetTimestamp is null
            ? string.Empty
            : $" until {DateTimeOffset.FromUnixTimeSeconds(resetTimestamp.Value).ToLocalTime():MM-dd HH:mm}";
    }

    private static string? Normalize(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
