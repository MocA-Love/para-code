# Normal Browser Startup Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline execution. Steps use checkbox syntax.

**Goal:** Stop enabling WebDriver mode by default while retaining CDP connectivity.
**Architecture:** Allocate a loopback port before Electron readiness and use its explicit number. Main-process CDP discovery reads its own command line before the legacy port file, retaining ownership checks.
**Tech Stack:** TypeScript, Node net, Electron, Mocha.
**Spec:** docs/superpowers/specs/2026-10-30-browser-startup-design.md

## Global Constraints

Preserve explicit debug port/pipe flags and loopback binding. No navigator patches. Preserve unrelated working changes. Commit only this fix on a branch based on the latest main; no publication.

## Review Focus

Explicit debugging flags; stale port files; foreign endpoints; allocation failure; Electron readiness ordering.

### Task 1: Startup and endpoint discovery

**Files:** Add node/paradisCdpStartup.ts and its node test in agentBrowser; modify src/mainImpl.ts and paradisCdpUpstreamPortPin.ts and its existing test.

- [x] Test nonzero allocation, explicit switches, failure, real loopback availability, and configured port ownership/discovery. Observe failures before implementation.
- [x] Implement async startup allocation before readiness, preserving explicit switches. Prefer configured port in the existing ownership-verified pinning path.
- [x] Run targeted suites, lint changed files and check TypeScript for the affected modules.
- [x] Verify real Electron reports webdriver=false and CDP responds; review the final diff.

## Execution record

Initial diagnosis: bundled Electron with port zero reports webdriver=true; explicit port reports false. An ESM top-level await for net allocation completes before app readiness. Real CDP /json/list responds HTTP 200.

Validation: 26 targeted Electron-hosted tests passed; changed-file TypeScript diagnostics: 0; five-file ESLint passed. Regression tests for configured-port discovery failed before the change (0 passed, 2 failed) and passed afterward. Independent scoped review found no issues.

Actual product default startup: CDP responded on port 42365 and the workbench reported navigator.webdriver=false. A sandboxed WebContentsView using the production allocator and production main-process port pin reported webdriver=false, app readiness still false during configuration, and configuredPort=pinnedPort=35907. Explicit debug flags remain intentional overrides. Google account authentication was not exercised.

Ruling: perform the change in the shared checkout without creating a worktree or committing, preserving the existing unrelated dirty changes. The runtime check uses isolated user/shared/extension directories and no explicit debugging port, because the standard launch helper would override the behavior under test.

Follow-up: at the user's request, pulled origin/main in an isolated managed worktree, then created para/browser-normal-startup. Latest main already suppresses AutomationControlled while using port zero; this change replaces that workaround with explicit nonzero allocation and command-line discovery. Original shared checkout changes remain separate.

Latest-main validation: Node 24.19.0; npm run build-fast -- --client-only passed; 26 targeted Electron tests passed; five-file ESLint passed; changed-file TypeScript diagnostics: 0; independent review of the latest-main transplant found no issues. Electron runtime version 43.7.7 matches both checkouts; the isolated worktree reuses only that runtime binary, with separately installed dependencies.
