/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Claude Code の Claude Mods（function hooks）で Para Code と Claude Code をつなぐ mod の共有定義。
//
// mod 本体は `resources/paradis/claude-mod/`（Claude Code の中で動く TypeScript）。Para Code は
// それを `~/.para-code/claude-mod/<内容の指紋>/` へ写し、手元のペインの環境変数
// `CLAUDE_CODE_PLUGIN_DIRS` で読ませる（paradisClaudeModEnvironment.ts）。mod は hook と同じ
// ループバックのポートとペイントークンで shared process の `/claude-mod/v1/<op>` へ話す
// （paradisClaudeModBridge.ts）。ここには両側（renderer と shared process）が使う名前と純関数だけを置く。

/** Claude Code が mod のフォルダを読む環境変数（`:` 区切り、Windows は `;`）。 */
export const PARADIS_CLAUDE_PLUGIN_DIRS_ENV_VAR = 'CLAUDE_CODE_PLUGIN_DIRS';

/** mod を読ませるか（`paradis.agentHooks.enabled` がオンのときだけ効く）。 */
export const PARADIS_CLAUDE_MOD_ENABLED_SETTING = 'paradis.agentHooks.claudeMod.enabled';

/** モバイルの承認を待つ上限（分）。0 なら承認はモバイルへ回さない（今までどおりキーで答える）。 */
export const PARADIS_CLAUDE_MOD_APPROVAL_WAIT_SETTING = 'paradis.agentHooks.claudeMod.approvalWaitMinutes';
export const PARADIS_CLAUDE_MOD_APPROVAL_WAIT_DEFAULT_MINUTES = 10;
const PARADIS_CLAUDE_MOD_APPROVAL_WAIT_MAX_MINUTES = 60;

/** shared process の受け口の接頭辞。mod の `register.ts` の URL と一致させること。 */
export const PARADIS_CLAUDE_MOD_HTTP_PREFIX = '/claude-mod/v1/';

/** 同梱の mod の場所（appRoot からの相対）。 */
export const PARADIS_CLAUDE_MOD_SOURCE_SEGMENTS: readonly string[] = ['resources', 'paradis', 'claude-mod'];

/**
 * 入力欄の文を Para Code へ知らせる 2 つ目の mod（`draft/`。mod のフォルダの中の別のプラグイン）。Claude Code は知らない
 * イベント名（`prompt.change` は 2.1.300 から）を含む mod を読み込まず、画面に断りを出すので、本体と分けて
 * {@link paradisSupportsClaudeDraftMod} の版にだけ読ませる。
 */
export const PARADIS_CLAUDE_DRAFT_MOD_SEGMENT = 'draft';

/**
 * mod のフォルダの中で写す（同梱する）ファイルか（mod のフォルダからの相対、`/` 区切り）。許可リスト: マニフェストと
 * `hooks/` の下だけ。入力欄の mod（`draft/`）も同じ形（テストや、Claude Code が読み込んだときに書き足す型定義・
 * tsconfig は写さない）。build/gulpfile.vscode.ts の同梱の glob（PARA-PATCH）と同じもの。
 */
export function paradisClaudeModShipsFile(relativePath: string): boolean {
	const inPlugin = relativePath.startsWith(`${PARADIS_CLAUDE_DRAFT_MOD_SEGMENT}/`) ? relativePath.slice(PARADIS_CLAUDE_DRAFT_MOD_SEGMENT.length + 1) : relativePath;
	return !relativePath.includes('/../') && (inPlugin === '.claude-plugin/plugin.json' || inPlugin.startsWith('hooks/'));
}

/**
 * PC の入力欄の文の様子（入力欄の mod の知らせから）。`unknown`: 分からない（古い Claude Code・mod の無い会話・まだ何も
 * 打っていない会話。今までどおり動く）、`empty`: 空、`text`: 書きかけがある、`cut`: 書きかけが長すぎて全部は分からない。
 */
export type ParadisClaudeDraftState = 'unknown' | 'empty' | 'text' | 'cut';

export function paradisClaudeDraftState(draft: { readonly text: string; readonly truncated: boolean } | undefined): ParadisClaudeDraftState {
	if (draft === undefined) {
		return 'unknown';
	}
	if (draft.truncated) {
		return 'cut';
	}
	return draft.text.length === 0 ? 'empty' : 'text';
}

/** 入力欄の mod（`prompt.change`）を読める Claude Code か（`claude --version` の出力。2.1.300 以降）。 */
export function paradisSupportsClaudeDraftMod(versionOutput: string | undefined): boolean {
	const match = versionOutput !== undefined ? /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput) : null;
	if (!match) {
		return false;
	}
	const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
	return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 300)));
}

/**
 * mod の会話の行のうち、表示にしか効かないものか。応答（assistant）の文章と思考だけからなる行に限る。
 * ツールの呼び出し・結果・添付や発言（prompt）は、質問のカード・回答待ち・サブエージェント・Monitor・送った発言の
 * 受理を作ったり消したりするので、送り主をその便で確かめたときにだけ使う（paradisClaudeModBridge.ts）。
 */
export function paradisIsDisplayOnlyModRow(door: unknown, role: unknown, content: unknown): boolean {
	return door === 'response' && role === 'assistant' && Array.isArray(content) && content.length > 0
		&& content.every(block => {
			const type = typeof block === 'object' && block !== null ? (block as { readonly type?: unknown }).type : undefined;
			return type === 'text' || type === 'thinking' || type === 'redacted_thinking';
		});
}

/** 使わなくなった指紋のフォルダを消すまでの日数（別の版の Para Code がまだ使っているかもしれないので、すぐには消さない）。 */
export const PARADIS_CLAUDE_MOD_STALE_INSTALL_MS = 30 * 24 * 60 * 60_000;

// ---- Claude Code の設定フォルダ（`CLAUDE_CONFIG_DIR`） -------------------------------------------
//
// renderer の browser 層からは環境変数が読めない。shared process が読んでいる場所（paradisClaudeConfigDir()）を
// electron-browser の contribution が教える（paradisClaudeModConfigDir.contribution.ts）。教わる前は ~/.claude だけを見る。

let claudeConfigDirProvider: (() => Promise<string | undefined>) | undefined;
const claudeConfigDirProviderListeners = new Set<() => void>();

/** shared process の Claude Code の設定フォルダを返す口を入れる（electron-browser のウィンドウだけ）。 */
export function paradisSetClaudeConfigDirProvider(provider: (() => Promise<string | undefined>) | undefined): void {
	claudeConfigDirProvider = provider;
	for (const listener of [...claudeConfigDirProviderListeners]) {
		listener();
	}
}

export function paradisClaudeConfigDirProvider(): (() => Promise<string | undefined>) | undefined {
	return claudeConfigDirProvider;
}

/** 口が入った（入れ直した）ときに呼ぶ。返す関数で外す。 */
export function paradisOnDidSetClaudeConfigDirProvider(listener: () => void): () => void {
	claudeConfigDirProviderListeners.add(listener);
	return () => claudeConfigDirProviderListeners.delete(listener);
}

// 同じく、shared process が確かめた Claude Code の版（`claude --version` の出力）。入力欄の mod を読ませてよいかに使う。
// 教わる前・確かめられないときは undefined（入力欄の mod は読ませない）。
let claudeVersionProvider: (() => Promise<string | undefined>) | undefined;

/** shared process が確かめた Claude Code の版を返す口を入れる（electron-browser のウィンドウだけ）。 */
export function paradisSetClaudeVersionProvider(provider: (() => Promise<string | undefined>) | undefined): void {
	claudeVersionProvider = provider;
}

export function paradisClaudeVersionProvider(): (() => Promise<string | undefined>) | undefined {
	return claudeVersionProvider;
}

/** 写し先（ホームからの相対）。版ごとに `<内容の指紋>` のフォルダを作り、一度作ったら書き換えない。 */
export const PARADIS_CLAUDE_MOD_INSTALL_SEGMENTS: readonly string[] = ['.para-code', 'claude-mod'];

/**
 * ペインの env に mod のフォルダを足す。ユーザーが既に設定している値は残して後ろへつなぐ。
 *
 * 呼び出し側が env に値を書いていればそれにつなぐ。書いていなければ `${env:...}` で親の環境
 * （ログインシェルの環境）の値を引き継ぐ。値が無いと空になり、先頭の区切り文字は Claude Code が
 * 読み飛ばす（空の要素は捨てる。2.1.288 の実装で確認）。
 */
export function paradisAddClaudePluginDir(
	env: Readonly<Record<string, string | null | undefined>> | undefined,
	pluginDirectory: string,
	delimiter: string,
): Record<string, string | null | undefined> {
	const current = env?.[PARADIS_CLAUDE_PLUGIN_DIRS_ENV_VAR];
	const base = typeof current === 'string' ? current : `\${env:${PARADIS_CLAUDE_PLUGIN_DIRS_ENV_VAR}}`;
	if (typeof current === 'string' && current.split(delimiter).includes(pluginDirectory)) {
		return { ...env };
	}
	return { ...env, [PARADIS_CLAUDE_PLUGIN_DIRS_ENV_VAR]: `${base}${delimiter}${pluginDirectory}` };
}

/** 設定値から、モバイルの承認を待つ上限（ミリ秒）を読む。 */
export function paradisClaudeModApprovalWaitMs(value: unknown): number {
	const minutes = typeof value === 'number' && Number.isFinite(value) ? value : PARADIS_CLAUDE_MOD_APPROVAL_WAIT_DEFAULT_MINUTES;
	return Math.round(Math.min(PARADIS_CLAUDE_MOD_APPROVAL_WAIT_MAX_MINUTES, Math.max(0, minutes)) * 60_000);
}

/**
 * Claude Code の managed 設定（組織の方針）が mod の読み込みを禁じているか。
 *
 * `disableSideloadFlags` が立っていると、Claude Code は `CLAUDE_CODE_PLUGIN_DIRS` を見た時点で
 * **起動そのものを止める**（2.1.288 の preAction で確認）。ペインに env を足すと claude が
 * 起動できなくなるので、立っていそうなら足さない。JSON は値で、plist（バイナリのこともある）は
 * 名前が現れるかだけで見る（読み違えるなら足さない側へ倒す）。
 */
export function paradisClaudeManagedSettingsBlockMods(text: string, format: 'json' | 'plist'): boolean {
	if (!text.includes('disableSideloadFlags')) {
		return false;
	}
	if (format === 'plist') {
		return true;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed !== 'object' || parsed === null || (parsed as { disableSideloadFlags?: unknown }).disableSideloadFlags !== false;
	} catch {
		return true;
	}
}
