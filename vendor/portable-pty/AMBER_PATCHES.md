# Amber patches

This directory vendors `portable-pty` 0.9.0 under its MIT license. Amber carries
two Windows-only fixes pending an upstream release:

- Do not pass `PSEUDOCONSOLE_INHERIT_CURSOR`. A headless daemon has no parent
  terminal to answer ConPTY's initial cursor-position query, and the flag can
  deadlock `ClosePseudoConsole` during session teardown.
- Interpret `TerminateProcess`'s nonzero return value as success in
  `WinChildKiller`, matching the Win32 API contract and current upstream code.

Keep all other vendored source identical to the crates.io 0.9.0 release.
