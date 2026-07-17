/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「URLからクローンしてリポジトリを追加」機能の共通定義。
// shared process 側の git 実行チャネル (paradisWorktreeGitChannel.ts) と
// workbench 側の QuickInput フロー (paradisAddRepositoryFlow.contribution.ts) の間で共有する。

/**
 * Workspaces ビューの「+」から開く統合フロー (URLクローン / ローカルフォルダ追加) のコマンドID。
 * electron-browser 側でのみ登録され、browser 側の Add Repository アクションは
 * このコマンドが登録されていれば委譲する (webビルドでは未登録なので従来のフォルダ選択になる)。
 */
export const PARADIS_ADD_REPOSITORY_FLOW_COMMAND_ID = 'paradis.workspaceSwitch.addRepositoryFlow';

/** クローン先の親ディレクトリを指定する設定キー。空なら毎回フォルダ選択ダイアログを出す。 */
export const PARADIS_CLONE_PARENT_DIR_SETTING = 'paradis.workspaceSwitch.cloneParentDirectory';

/** git clone の要求。パスはネイティブファイルシステムパス。 */
export interface IParadisCloneRepositoryRequest {
	/** クローン元URL (https / ssh / git / scp風 のいずれか。呼び出し側で検証済みであること)。 */
	readonly url: string;
	/** クローン先ディレクトリ (未存在であること。親は無ければ作成される)。 */
	readonly targetPath: string;
	/** 進捗イベントの紐付けとキャンセルに使う一意ID。 */
	readonly cloneId: string;
}

/** git clone の進捗イベント (shared process → workbench)。 */
export interface IParadisCloneProgressEvent {
	readonly cloneId: string;
	/** 表示用メッセージ ("Receiving objects: 62% (1204/1943)" 等)。 */
	readonly message: string;
	/** ステージを合成した全体進捗 (0-100)。単調増加する。 */
	readonly overallPercent: number;
}

/** paradisParseGitUrl の解析結果。 */
export interface IParadisParsedGitUrl {
	/** URLから導いたリポジトリ名 (クローン先ディレクトリ名になる)。 */
	readonly name: string;
}

/** ディレクトリ名として安全に使える名前か ('-' 始まりやドットのみの名前を拒否)。 */
function isSafeRepositoryName(name: string): boolean {
	return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name) && !name.startsWith('-');
}

/** URLのパス部分の末尾セグメントからリポジトリ名を導く。 */
function repositoryNameFromPath(path: string): string | undefined {
	const trimmed = path.replace(/\/+$/, '');
	const lastSegment = trimmed.split('/').pop() ?? '';
	const name = lastSegment.replace(/\.git$/i, '');
	return isSafeRepositoryName(name) ? name : undefined;
}

/**
 * Git リポジトリURLとして解釈できれば、リポジトリ名を返す。解釈できなければ undefined。
 * 対応形式: https(s)://…、ssh://…、git://…、scp風 (git@github.com:user/repo.git)。
 * ローカルパス ("C:\repo" や "/tmp/repo") は対象外 (ローカルはフォルダ追加で扱う)。
 */
export function paradisParseGitUrl(value: string): IParadisParsedGitUrl | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 2048 || /\s/.test(trimmed)) {
		return undefined;
	}
	if (/^(https?|ssh|git):\/\//i.test(trimmed)) {
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			return undefined;
		}
		if (!parsed.hostname) {
			return undefined;
		}
		// new URL は不正な %-encoding ("%zz" 等) を通すため、decode 失敗時は素の値で続行する
		// (最終的に isSafeRepositoryName が弾く)。入力中の値でも呼ばれるので throw させない
		let pathname = parsed.pathname;
		try {
			pathname = decodeURIComponent(parsed.pathname);
		} catch {
			// 素の pathname のまま
		}
		const name = repositoryNameFromPath(pathname);
		return name ? { name } : undefined;
	}
	// scp風 (user@host:path)。user@ を必須にすることで Windows のドライブパス等を除外する
	const scpLike = trimmed.match(/^[\w.-]+@[\w.-]+:(?<path>[^:]+)$/);
	if (scpLike?.groups) {
		const name = repositoryNameFromPath(scpLike.groups.path);
		return name ? { name } : undefined;
	}
	return undefined;
}

/** git clone --progress の stderr 1行分の解析結果。 */
export interface IParadisCloneProgressLine {
	readonly stage: string;
	readonly percent: number;
}

const CLONE_PROGRESS_LINE_REGEX = /^(?:remote:\s*)?(?<stage>Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking out files):\s+(?<percent>\d+)%/;

/** git clone --progress の stderr 1行を解析する。進捗行でなければ undefined。 */
export function paradisParseCloneProgressLine(line: string): IParadisCloneProgressLine | undefined {
	const match = line.match(CLONE_PROGRESS_LINE_REGEX);
	if (!match?.groups) {
		return undefined;
	}
	const percent = Number.parseInt(match.groups.percent, 10);
	if (!Number.isFinite(percent)) {
		return undefined;
	}
	return { stage: match.groups.stage, percent: Math.min(100, Math.max(0, percent)) };
}

/**
 * ステージごとの全体進捗への割り当て区間。転送の大半を占める Receiving objects に
 * 広い幅を与える (Superset はステージ内%をそのまま出すが、通知の単一バーでは
 * ステージ切り替わりで巻き戻って見えるため合成する)。
 */
const CLONE_STAGE_SPANS: ReadonlyArray<{ readonly stage: string; readonly from: number; readonly to: number }> = [
	{ stage: 'Enumerating objects', from: 0, to: 3 },
	{ stage: 'Counting objects', from: 3, to: 6 },
	{ stage: 'Compressing objects', from: 6, to: 10 },
	{ stage: 'Receiving objects', from: 10, to: 85 },
	{ stage: 'Resolving deltas', from: 85, to: 95 },
	{ stage: 'Updating files', from: 95, to: 100 },
	{ stage: 'Checking out files', from: 95, to: 100 },
];

/** ステージ内% (0-100) を全体進捗 (0-100) へ合成する。未知のステージは undefined。 */
export function paradisCloneOverallPercent(stage: string, percent: number): number | undefined {
	const span = CLONE_STAGE_SPANS.find(candidate => candidate.stage === stage);
	if (!span) {
		return undefined;
	}
	const bounded = Math.min(100, Math.max(0, percent));
	return Math.round(span.from + (span.to - span.from) * (bounded / 100));
}
