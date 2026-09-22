---
name: testflight-probe
description: Deterministic Factory acceptance probe. Echo the supplied probe token and report the active model and repository head without modifying anything. Use only when a Factory acceptance harness invokes it by name.
---

# Testflight probe

This is a qualification fixture for Factory dispatch mechanics. It must not change any file, branch, issue or pull request.

## Input

The invocation arguments are a single line of the form `probe=<token>`.

## Steps

1. Run `git rev-parse HEAD` in the workspace and note the full SHA.
2. Reply with exactly these three lines and nothing else:

```text
TESTFLIGHT_PROBE=<token>
TESTFLIGHT_HEAD=<full sha from step 1>
TESTFLIGHT_SKILL=testflight-probe
```

Do not call any stage-transition tool. Do not run any other command.
