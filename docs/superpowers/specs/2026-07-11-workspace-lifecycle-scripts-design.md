# Workspace Lifecycle Scripts Design

## Goal

Allow each repository registered in the Para Code Workspaces view to define setup and teardown shell scripts for its worktrees. The scripts are stored in the repository's `.paracode.json`, can be edited from the Workspaces view, and run as part of Para Code's worktree creation and removal lifecycle.

## Configuration

Add two optional top-level string properties to `.paracode.json`:

```json
{
	"setupScript": "cd frontend && bun i && cd ../backend && bun i && cd .. && cp \"$PARACODE_PROJECT_ROOT_PATH/frontend/.env\" frontend/.env && claude /setup-parallel-dev",
	"teardownScript": "docker image prune",
	"presets": []
}
```

Both properties are optional. Missing, empty, or whitespace-only values disable the corresponding lifecycle action. Reading and writing these properties must preserve `presets` and all unknown top-level properties.

The configuration belongs to the parent repository. A worktree uses the `.paracode.json` from its registered parent repository rather than a potentially modified copy inside the worktree.

## Editing Experience

Add a **Setup/Teardown Scripts...** action to the context menu for parent repository rows in the Workspaces view. The action opens a dialog containing separate multiline inputs for the setup and teardown scripts.

Saving updates only `setupScript` and `teardownScript` in the parent repository's `.paracode.json`. Blank inputs remove their corresponding properties. If the file does not exist, saving at least one non-empty script creates it. If both inputs are blank and no file exists, saving is a no-op.

Malformed `.paracode.json` content must not be overwritten. The dialog reports the parse error and leaves the file unchanged.

## Execution Model

Lifecycle scripts run through the user's login shell. Para Code waits for the process to exit and captures its exit status and error output.

For both scripts:

- The current working directory is the target worktree.
- `PARACODE_PROJECT_ROOT_PATH` contains the absolute native path of the registered parent repository.
- The user's existing environment is preserved.
- Workspace Trust is required because `.paracode.json` can contain arbitrary commands.
- Script text is passed to the shell unchanged; Para Code does not rewrite commands such as `docker images prune`.

The shared-process worktree channel owns execution so it can run a real child process, wait for completion, and return structured failures to the workbench.

## Setup Lifecycle

The creation sequence is:

1. Create the git worktree and register it in the Workspaces view.
2. Switch the active workspace to the new worktree.
3. Load `setupScript` from the parent repository's `.paracode.json`.
4. Run the setup script and wait for completion.
5. Run existing auto-run terminal presets.
6. Create the default terminal when applicable.
7. Start the selected agent CLI when applicable.

If setup exits unsuccessfully or cannot be started, the worktree remains available, an error is shown, and steps 5–7 do not run. Worktree creation is not rolled back because the setup command may already have produced useful files or partial state.

## Teardown Lifecycle

After the user confirms removal, the sequence is:

1. Load `teardownScript` from the parent repository's `.paracode.json`.
2. Run the teardown script in the target worktree and wait for completion.
3. If the target is active, switch to its parent repository.
4. Run the existing normal `git worktree remove` flow, including the current force-removal confirmation when required.
5. Remove the worktree from the known-worktree list.

If teardown exits unsuccessfully or cannot be started, removal stops before switching workspaces or invoking Git. The error is shown and the worktree remains unchanged.

## Error Handling and Safety

- A missing `.paracode.json` or missing lifecycle property means there is nothing to run.
- Invalid property types are ignored for execution and shown as empty in the editor; saving normalizes edited values to strings or removes them.
- A malformed JSON/JSONC file prevents editing and execution. Execution reports the configuration error instead of silently skipping a script.
- Process failures include the script kind, exit code when available, and captured standard error in the user-facing error detail and logs.
- Setup and teardown cannot run concurrently within the worktree operation that initiated them because each lifecycle step is awaited.
- Existing Workspace Trust behavior remains the security boundary for repository-provided commands.

## Components

### Lifecycle configuration helper

A focused helper reads and patches lifecycle properties in `.paracode.json`. It reuses the repository configuration filename already defined by terminal presets and keeps JSONC parsing behavior consistent with the existing preset service.

### Lifecycle process runner

The shared-process worktree Git channel gains a lifecycle-script operation accepting the repository path, worktree path, script kind, and script text. It resolves the login shell, adds `PARACODE_PROJECT_ROOT_PATH`, runs in the worktree, and returns only after exit.

### Workspaces action and dialog

An Electron-workbench action opens the editor dialog for the selected parent repository. The dialog reads and writes the parent repository configuration through the lifecycle configuration helper.

### Creation and removal integration

The worktree creation dialog invokes setup at the agreed point before auto-run presets. The remove action invokes teardown before switching away from or deleting the target worktree.

## Testing

Automated tests cover:

- Reading missing, valid, wrong-type, and malformed lifecycle configuration.
- Updating lifecycle fields while preserving presets and unknown fields.
- Removing fields for blank values and avoiding unnecessary file creation.
- Building the lifecycle process request with the target worktree as `cwd` and the parent path as `PARACODE_PROJECT_ROOT_PATH`.
- Successful execution and non-zero exit propagation.
- Setup ordering before auto-run and agent launch, with later steps skipped on failure.
- Teardown ordering before workspace switching and Git removal, with removal skipped on failure.
- No lifecycle execution when the corresponding property is absent or blank.

TypeScript compilation is checked before focused tests, following the repository validation requirements.

## Out of Scope

- User-level or machine-level lifecycle scripts.
- Per-worktree overrides.
- Automatic migration from terminal preset `autoRun` entries.
- Shell command validation or rewriting.
- Rollback of a worktree after setup failure.
