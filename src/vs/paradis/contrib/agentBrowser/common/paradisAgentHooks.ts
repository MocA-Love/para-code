/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// エージェントCLI (Claude Code / Codex) の通知hook設置に関する共有定義。
// 自動設置 (node/paradisAgentHooksSetup.ts) と手動スニペットコピー
// (workspaceSwitch/electron-browser/paradisAgentStatus.contribution.ts) の両方から参照される。
// バージョン依存イベントは自動設置側で対応確認後にだけ追加する。

/**
 * ホームディレクトリ相対の notify スクリプト設置先 (POSIX)。
 * このパスが「当fork管理のhookである」ことを識別するマーカーを兼ねる
 * (~/.claude/settings.json / ~/.codex/hooks.json の冪等マージ時)。
 */
export const PARADIS_AGENT_HOOK_SCHEMA_VERSION = 3;

/** notify scriptとshared processで共有するraw hook JSONの受信上限。 */
export const PARADIS_AGENT_HOOK_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** スキーマ版をファイル名に含め、旧Para Codeが新しいhookを管理対象として削除しないようにする。 */
export const PARADIS_NOTIFY_HOOK_RELATIVE_PATH = `.para-code/hooks/notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION}.sh`;

/** Windows用 notify スクリプト (PowerShell) の設置先。役割は上のPOSIX版と同じ。 */
export const PARADIS_NOTIFY_HOOK_RELATIVE_PATH_PS1 = `.para-code/hooks/notify-v${PARADIS_AGENT_HOOK_SCHEMA_VERSION}.ps1`;

/** スキーマ導入前のPara Code hook。現行版への移行時だけ除去する。 */
export const PARADIS_LEGACY_NOTIFY_HOOK_RELATIVE_PATHS = [
	'.para-code/hooks/notify.sh',
	'.para-code/hooks/notify.ps1',
] as const;

/**
 * 「この hook は SSH で繋いだ先から届いた」ことを示す印を載せる、hook URL のクエリ名。
 *
 * 接続先へ置く notify スクリプトにだけ焼き込む（生成経路が手元用と分かれている）。印が無い
 * hook は従来どおり手元のものとして扱うので、旧版のスクリプトが残っている接続先でも壊れない。
 */
export const PARADIS_AGENT_HOOK_REMOTE_HOST_PARAM = 'host';

/** 印の長さの上限。URLに載る値なので短く切る。 */
const PARADIS_AGENT_HOOK_REMOTE_HOST_MAX_LENGTH = 64;

/**
 * 接続先を表す印を、リモートオーソリティ (`ssh-remote+<host>`) から組み立てる。
 *
 * 値はそのまま URL のクエリに載るので、英数と `._-` だけに畳む。畳んだ結果として別々の
 * 接続先が同じ印になることはあり得るが、この印の用いどころは「接続先のものか」の判定と
 * 記録の区別だけなので実害はない。
 *
 * @returns 印。組み立てられない (空・記号だけ) ときは undefined
 */
export function paradisAgentHookRemoteHostId(remoteAuthority: string | undefined): string | undefined {
	if (typeof remoteAuthority !== 'string') {
		return undefined;
	}
	const sanitized = remoteAuthority.trim().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, PARADIS_AGENT_HOOK_REMOTE_HOST_MAX_LENGTH);
	return /[A-Za-z0-9]/.test(sanitized) ? sanitized : undefined;
}

/**
 * 受け取った印が、こちらが組み立てた形かどうか。
 *
 * hook はペインの環境変数を継いだプロセスなら誰でも名乗れる前提なので、形だけを確かめて
 * 受ける（この印は「接続先のパスを写す対象にしてよい」の判断にしか使わず、パスそのものの
 * 安全確認は従来どおり別に行う）。
 */
export function paradisIsAgentHookRemoteHostId(value: string | null | undefined): value is string {
	return typeof value === 'string'
		&& value.length > 0
		&& value.length <= PARADIS_AGENT_HOOK_REMOTE_HOST_MAX_LENGTH
		&& /^[A-Za-z0-9._-]+$/.test(value);
}

/**
 * hook登録イベント1件 (Claude Code の settings.json / Codex の hooks.json は同じ
 * `{ hooks: { EventName: [{ matcher?, hooks: [{ type, command }] }] } }` 構造)。
 */
export interface IParadisManagedHookEvent {
	readonly eventName: string;
	/** ツール系イベント (PostToolUse 等) に付ける matcher。 */
	readonly matcher?: string;
}

/**
 * ~/.claude/settings.json に登録するイベント一覧 (Superset の createClaudeSettingsJson と同方針)。
 * PreToolUse は全ツールを登録する: Claude Code は AskUserQuestion の
 * tool_use 行を回答/中断の決着まで transcript へ flush しないため、transcript 監視では
 * 質問中をライブ検知できない（PreToolUse hook の tool_input が唯一のライブな供給源）。
 * それ以外のツールはモバイルのライブティッカー供給源として使い、状態判定では
 * PermissionRequest と分離して working に正規化する。
 */
export const PARADIS_CLAUDE_HOOK_EVENTS: readonly IParadisManagedHookEvent[] = [
	{ eventName: 'SessionStart' },
	{ eventName: 'SessionEnd' },
	{ eventName: 'UserPromptSubmit' },
	{ eventName: 'Stop' },
	{ eventName: 'PreToolUse', matcher: '*' },
	{ eventName: 'PostToolUse', matcher: '*' },
	{ eventName: 'PermissionRequest', matcher: '*' },
	{ eventName: 'Notification' },
	// 以下は現行 Claude Code の追加イベント (旧バージョンでは未知イベントとして発火しないだけで無害)。
	// matcher は付けない (省略 = 全マッチ。イベントごとの matcher 対応差の影響を受けない)。
	// - PostToolUseFailure: ツール失敗後もターン継続 → working の維持 (失敗を完了と誤認しない)
	// - StopFailure: APIエラーでターン終了 → Stop と同じ「終わった」扱い (止まったのに実行中表示のまま、を防ぐ)
	// - PermissionDenied: 拒否後もターン継続 → working の維持
	// - CwdChanged: 状態は変えないが transcript_path 付きで届くため、セッション対応の再マップに使う
	{ eventName: 'PostToolUseFailure' },
	{ eventName: 'StopFailure' },
	{ eventName: 'PermissionDenied' },
	{ eventName: 'CwdChanged' },
];

/**
 * Claude Code 2.1.205 で実地確認した生成中メッセージイベント。
 * 旧版は未知のhookキーを settings.json の検証時に拒否し得るため、静的な一覧へは含めず、
 * 自動設置側が対応バージョンを確認できた場合にだけ追加する。
 */
export const PARADIS_CLAUDE_MESSAGE_DISPLAY_HOOK_EVENT: IParadisManagedHookEvent = { eventName: 'MessageDisplay' };

/** Claude Code 2.1.207でpayloadを確認し、モバイルactivityへ実際に写像する追加hook。 */
export const PARADIS_CLAUDE_ACTIVITY_HOOK_EVENTS: readonly IParadisManagedHookEvent[] = [
	{ eventName: 'SubagentStart' },
	{ eventName: 'SubagentStop' },
	{ eventName: 'TaskCreated' },
	{ eventName: 'TaskCompleted' },
	{ eventName: 'TeammateIdle' },
	{ eventName: 'PreCompact' },
	{ eventName: 'PostCompact' },
];

/**
 * ~/.codex/hooks.json に登録するイベント一覧 (Superset の createCodexHooksJson ベース)。
 * PermissionRequest は Codex 0.129+ の安定hooksに存在し、承認待ち状態の検出
 * (モバイルの承認バッジ/チャットミラー) に使う。旧バージョンでは未知イベントとして
 * 単に発火しないだけで無害。
 */
export const PARADIS_CODEX_HOOK_EVENTS: readonly IParadisManagedHookEvent[] = [
	{ eventName: 'SessionStart' },
	{ eventName: 'UserPromptSubmit' },
	{ eventName: 'PermissionRequest' },
	{ eventName: 'Stop' },
	// ツール開始をライブティッカーへ反映する。PermissionRequestとは別イベントなので、
	// 通常のツール実行を許可待ち扱いにはしない。
	{ eventName: 'PreToolUse' },
	// PostToolUse: 長いターンの途中でも「実行中」を維持するライブネス供給源。Codex の新hooksは
	// Claude Code 互換の stdin JSON (transcript_path 付き) を送るため、hook 未発火起因の
	// セッション未特定からの自己回復にも効く。Codex hooks.json の対応イベントは10種のみで、
	// それ以外の名前は無視される (イベントを増やす場合は対応表を必ず確認すること)。
	{ eventName: 'PostToolUse' },
];

/**
 * 設定ファイルに書き込むhookコマンド (sh 1行)。$HOME 参照で実行時解決するため
 * dev/製品ビルドで同一文字列になり、スクリプトが無い環境では即 true で無害。
 */
export function paradisManagedAgentHookCommand(): string {
	return `[ -x "$HOME/${PARADIS_NOTIFY_HOOK_RELATIVE_PATH}" ] && "$HOME/${PARADIS_NOTIFY_HOOK_RELATIVE_PATH}" || true`;
}

/**
 * Windows用のhookコマンド (1行)。Claude Code のhookは Git Bash があれば bash、無ければ
 * PowerShell で、Codex のhookは cmd (/C) で実行されるため、この3シェルすべてで同じ意味に
 * なる「powershell.exe を絶対パス引数付きで直接起動する」形にする ($HOME/%USERPROFILE% の
 * 展開仕様がシェルごとに違うため、パスは設置時に絶対パスへ埋め込む)。
 * パス区切りは3シェルすべてが受け付ける '/' に正規化する。
 */
export function paradisManagedAgentHookCommandWindows(homeDir: string): string {
	const scriptPath = `${homeDir.replace(/\\/g, '/')}/${PARADIS_NOTIFY_HOOK_RELATIVE_PATH_PS1}`;
	return `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
}

/** 1イベント分のhook定義オブジェクトを組み立てる (自動マージ・手動スニペットで共用)。 */
export function paradisManagedHookDefinition(event: IParadisManagedHookEvent, command: string = paradisManagedAgentHookCommand()): { readonly matcher?: string; readonly hooks: readonly { readonly type: string; readonly command: string }[] } {
	const entry = { type: 'command', command };
	return event.matcher !== undefined ? { matcher: event.matcher, hooks: [entry] } : { hooks: [entry] };
}
