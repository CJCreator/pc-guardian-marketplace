---
description: Check that PC Guardian can read this Windows machine (Windows version, PowerShell, display language, elevation). Read-only; changes nothing.
allowed-tools: mcp__pc-guardian__self_check
user-invocable: false
---

Call the `mcp__pc-guardian__self_check` tool once. Do not guess any value it did not return.

Then tell the user, in two or three short sentences:

- whether PC Guardian can read this machine, and the Windows version and build it found;
- whether Claude Code is running as a standard user or elevated, and that checks needing administrator rights are reported as "Not checked" rather than guessed;
- that the check only reads information and changed nothing.

If the tool reports "Not checked", quote its reason and suggest the next step it implies (for example, PC Guardian only supports Windows 10 and 11).
