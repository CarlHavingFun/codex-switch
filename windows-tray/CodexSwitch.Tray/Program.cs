using CodexSwitch.Tray.Cli;

namespace CodexSwitch.Tray;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(
            new TrayApplicationContext(
                new CodexSwitchCliClient(
                    new CliProcessRunner(CodexSwitchCliSettings.CreateDefault()))));
    }
}
