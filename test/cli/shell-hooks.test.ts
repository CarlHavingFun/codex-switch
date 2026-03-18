import { describe, expect, test } from "vitest";

import { renderShellHook } from "../../src/cli/shell-hooks.js";

describe("renderShellHook", () => {
  test("renders a PowerShell wrapper that forwards args into codex-switch run", () => {
    expect(renderShellHook("pwsh")).toContain("& codex-switch run -- @args");
  });

  test("renders POSIX shell wrappers for bash and zsh", () => {
    expect(renderShellHook("bash")).toContain('command codex-switch run -- "$@"');
    expect(renderShellHook("zsh")).toContain('command codex-switch run -- "$@"');
  });
});
