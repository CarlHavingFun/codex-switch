export type SupportedShell = "pwsh" | "bash" | "zsh";

export function renderShellHook(shell: SupportedShell): string {
  switch (shell) {
    case "pwsh":
      return [
        "function codex {",
        "  & codex-switch run -- @args",
        "}",
      ].join("\n");
    case "bash":
    case "zsh":
      return [
        "codex() {",
        '  command codex-switch run -- "$@"',
        "}",
      ].join("\n");
  }
}
