using CodexSwitch.Tray.Models;
using CodexSwitch.Tray.Presentation;

namespace CodexSwitch.Tray.Tests;

public sealed class ProfileMenuFormatterTests
{
    [Fact]
    public void FormatProfileLabel_PrefersManualWorkspaceNameAndCreditsSummary()
    {
        ManagedProfileDto profile = CreateProfile();
        ProfileStatusDto status = CreateStatus(profile, new UsageSummaryDto(
            "credits",
            "42.00",
            25,
            75,
            1_730_947_200,
            5,
            95,
            1_731_033_600,
            "team"));

        string label = ProfileMenuFormatter.FormatProfileLabel(profile, status);

        Assert.Contains("workspace-a [chatgpt]", label);
        Assert.Contains("Manual Team", label);
        Assert.DoesNotContain("Manual Team / Observed Team", label);
        Assert.Contains("credits 42.00", label);
        Assert.Contains(
            DateTimeOffset.FromUnixTimeSeconds(1_730_947_200).ToLocalTime().ToString("MM-dd HH:mm"),
            label);
    }

    [Fact]
    public void FormatActiveSummary_UsesWindowUsageWhenCreditsAreUnavailable()
    {
        ManagedProfileDto profile = CreateProfile();
        ProfileStatusDto status = CreateStatus(profile, new UsageSummaryDto(
            "window",
            null,
            42,
            58,
            1_735_693_200,
            null,
            null,
            null,
            "pro"));

        string summary = ProfileMenuFormatter.FormatActiveSummary(
            profile,
            new Dictionary<string, ProfileStatusDto>
            {
                [profile.Id] = status,
            });

        Assert.Contains("Current: workspace-a", summary);
        Assert.Contains("58% left", summary);
    }

    private static ManagedProfileDto CreateProfile() =>
        new(
            "profile-1",
            "workspace-a",
            @"C:\profiles\workspace-a\home",
            "chatgpt",
            "acct_1",
            "team",
            "Manual Team",
            "Observed Team",
            "fingerprint-1",
            null,
            null,
            true);

    private static ProfileStatusDto CreateStatus(
        ManagedProfileDto profile,
        UsageSummaryDto usageSummary) =>
        new(
            profile,
            "Logged in using ChatGPT",
            new AccountDto("chatgpt", "person@example.com", "team"),
            null,
            false,
            usageSummary);
}
