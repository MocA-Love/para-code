# Terminal Space Restart Ownership Design

## Problem

Para Code persists terminal-to-space ownership by `persistentProcessId`. A full desktop restart revives terminal processes under newly allocated IDs, while the saved ownership ledger still uses the previous IDs. A new ID can therefore collide with another terminal's old ID and assign the revived terminal to the wrong space before cwd-based recovery runs.

## Design

The PTY host already owns the authoritative old-to-new ID mapping during process revival. Attach targets produced for a revived process will carry an optional Para Code-specific `paradisRevivedFromPersistentProcessId` field containing the previous-session ID.

The workspace terminal scope service will keep a restore-only snapshot of the ownership ledger loaded at startup. Restored terminal lookup will use `paradisRevivedFromPersistentProcessId` when present and otherwise use the current persistent process ID, preserving window-reload behavior and backward compatibility. Current-session PID writes never update this snapshot; startup worktree validation and scope retirement may add or remove entries. Once ownership is recovered, the mutable ledger continues recording the current process ID for the next shutdown.

Inactive-space terminal editors restored from the orphan process list use the same old-ID metadata. Scope retirement removes entries from both the mutable ledger and the startup snapshot.

## Alternatives Rejected

- Migrating all ownership persistence to `paradisPaneToken` would provide a stable identity but requires a larger storage migration and changes across every ownership lifecycle path.
- Recomputing ownership only from cwd fails when a terminal has changed directory outside its owning repository or worktree.

## Verification

- A regression test models an old ID `3` revived as current ID `2` while old ID `2` belongs to another scope; lookup must select the scope recorded under old ID `3`.
- Existing same-ID restore behavior remains covered.
- Run client type checking and the focused workspace-switch unit suite.
