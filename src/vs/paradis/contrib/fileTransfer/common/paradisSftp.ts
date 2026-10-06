/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 接続していないホストへ、SSH（SFTP）で直接送る・取ってくる（段階 1）の共通の定義。
//
// 接続は shared process の ssh2 が張り（node/paradisSftpConnection.ts）、renderer には `paradis-sftp://<別名>/<絶対パス>`
// の IFileSystemProvider として見せる（electron-browser/paradisSftpFileSystemProvider.ts）。転送の待ち行列は IFileService を
// 通しているので、このスキームでもそのまま動く。このウィンドウが開いているホストは今までどおり `vscode-remote://` を使う。
//
// ここはスキーム・チャネル名・型と、`ssh -G` の出力や `~/.ssh/config` の解釈、どの経路を使うかの判定を持つ（どれも純関数）。

import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { parseSSHGOutput, tokenizeSSHPathList } from '../../../../platform/agentHost/common/sshConfigParsing.js';

/** renderer に見せるスキーム。authority は `~/.ssh/config` の別名、path は接続先の絶対パス。 */
export const PARADIS_SFTP_SCHEME = 'paradis-sftp';
/** shared process に生やすチャネル。 */
export const PARADIS_SFTP_CHANNEL = 'paradisSftp';

/** 使い終わった接続を閉じるまでの秒数の設定。 */
export const PARADIS_SFTP_IDLE_SETTING = 'paradis.fileTransfer.directConnectionIdleSeconds';
export const PARADIS_SFTP_IDLE_DEFAULT_SECONDS = 300;
export const PARADIS_SFTP_IDLE_MIN_SECONDS = 30;
export const PARADIS_SFTP_IDLE_MAX_SECONDS = 3600;

/** 設定の値を、範囲に収めたミリ秒に直す。 */
export function paradisSftpIdleMs(seconds: unknown): number {
	const value = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : PARADIS_SFTP_IDLE_DEFAULT_SECONDS;
	return Math.round(Math.min(PARADIS_SFTP_IDLE_MAX_SECONDS, Math.max(PARADIS_SFTP_IDLE_MIN_SECONDS, value)) * 1000);
}

// --- 接続の設定 ------------------------------------------------------------------------------------

/** 1 ホストぶんの、接続に使う設定（`ssh -G` か `~/.ssh/config` から）。 */
export interface IParadisSshHostConfig {
	readonly alias: string;
	readonly hostname: string;
	readonly port: number;
	readonly user: string;
	/** `~` は展開していない（node 側で展開する）。 */
	readonly identityFiles: readonly string[];
	readonly identitiesOnly: boolean;
	/** `IdentityAgent` の生の値（`none` / `SSH_AUTH_SOCK` / `$VAR` / パス）。無ければ undefined。 */
	readonly identityAgent?: string;
	readonly proxyCommand?: string;
	/** 段階 1 では使えない。あれば接続せずに断る。 */
	readonly proxyJump?: string;
	/** known_hosts をこの名前で引く。 */
	readonly hostKeyAlias?: string;
	readonly userKnownHostsFiles: readonly string[];
	readonly globalKnownHostsFiles: readonly string[];
}

/** `ssh -G` が既定で出す known_hosts と同じもの（自前で読むときの既定）。 */
export const PARADIS_DEFAULT_USER_KNOWN_HOSTS = ['~/.ssh/known_hosts', '~/.ssh/known_hosts2'];
export const PARADIS_DEFAULT_GLOBAL_KNOWN_HOSTS = ['/etc/ssh/ssh_known_hosts', '/etc/ssh/ssh_known_hosts2'];
/** IdentityFile が無いときに OpenSSH が試す鍵。 */
export const PARADIS_DEFAULT_IDENTITY_FILES = ['~/.ssh/id_rsa', '~/.ssh/id_ecdsa', '~/.ssh/id_ecdsa_sk', '~/.ssh/id_ed25519', '~/.ssh/id_ed25519_sk', '~/.ssh/id_dsa'];

function noneToUndefined(value: string | undefined): string | undefined {
	return value && value.toLowerCase() !== 'none' ? value : undefined;
}

/**
 * `ssh -G -- <別名>` の出力を設定に直す。upstream の `parseSSHGOutput` に、段階 1 で要る
 * `identitiesonly`・`proxyjump`・`hostkeyalias` を足す。known_hosts の一覧は呼ぶ側が
 * `resolveSSHKnownHostsFiles` で（ファイルの有無を見て）解いたものを渡す。
 */
export function paradisSshConfigFromSshG(alias: string, stdout: string, knownHosts?: { readonly userKnownHostsFiles: readonly string[]; readonly globalKnownHostsFiles: readonly string[] }): IParadisSshHostConfig {
	const parsed = parseSSHGOutput(stdout);
	const extra = new Map<string, string>();
	for (const line of stdout.split('\n')) {
		const match = /^(?<key>identitiesonly|proxyjump|hostkeyalias)\s+(?<value>.+)$/i.exec(line.trim());
		if (match?.groups) {
			extra.set(match.groups.key.toLowerCase(), match.groups.value.trim());
		}
	}
	return {
		alias,
		hostname: parsed.hostname || alias,
		port: Number.isInteger(parsed.port) && parsed.port > 0 ? parsed.port : 22,
		user: parsed.user ?? '',
		identityFiles: parsed.identityFile,
		identitiesOnly: extra.get('identitiesonly')?.toLowerCase() === 'yes',
		identityAgent: parsed.identityAgent,
		proxyCommand: parsed.proxyCommand,
		proxyJump: noneToUndefined(extra.get('proxyjump')),
		hostKeyAlias: noneToUndefined(extra.get('hostkeyalias')),
		userKnownHostsFiles: knownHosts?.userKnownHostsFiles ?? parsed.userKnownHostsFiles,
		globalKnownHostsFiles: knownHosts?.globalKnownHostsFiles ?? parsed.globalKnownHostsFiles,
	};
}

/** `Host` の 1 つのパターンが別名に当たるか（`*`・`?`、大文字小文字は区別しない）。 */
function hostPatternMatches(pattern: string, alias: string): boolean {
	const escaped = pattern.toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp(`^${escaped}$`).test(alias.toLowerCase());
}

/** `Host a b !c` の行が別名に当たるか。否定が 1 つでも当たれば当たらない（OpenSSH と同じ）。 */
function hostLineMatches(patterns: readonly string[], alias: string): boolean {
	let matched = false;
	for (const pattern of patterns) {
		if (pattern.startsWith('!')) {
			if (hostPatternMatches(pattern.slice(1), alias)) {
				return false;
			}
		} else if (hostPatternMatches(pattern, alias)) {
			matched = true;
		}
	}
	return matched;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

/**
 * `ssh` が起動できない環境の代わりに、`~/.ssh/config` を自前で解く（Include は呼ぶ側が展開して行に混ぜる）。
 * OpenSSH と同じく、当たった `Host` のうち**最初に出てきた値が勝つ**（`IdentityFile` だけは積み上がる）。
 * `Match` は解かずに、その節を当たらないものとして飛ばす。
 */
export function paradisSshConfigFromFile(alias: string, lines: readonly string[], localUser: string): IParadisSshHostConfig {
	const values = new Map<string, string>();
	const identityFiles: string[] = [];
	let active = true;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const match = /^(?<key>[A-Za-z]+)(?:\s*=\s*|\s+)(?<value>.*)$/.exec(line);
		if (!match?.groups) {
			continue;
		}
		const key = match.groups.key.toLowerCase();
		const value = match.groups.value.replace(/\s+#.*$/, '').trim();
		if (key === 'host') {
			active = hostLineMatches(value.split(/\s+/).filter(Boolean), alias);
			continue;
		}
		if (key === 'match') {
			active = false;
			continue;
		}
		if (!active) {
			continue;
		}
		if (key === 'identityfile') {
			identityFiles.push(unquote(value));
		} else if (!values.has(key)) {
			values.set(key, unquote(value));
		}
	}
	const port = parseInt(values.get('port') ?? '22', 10);
	const hostname = (values.get('hostname') ?? alias).replace(/%h/g, alias);
	const knownHosts = (key: string, fallback: readonly string[]) => {
		const value = values.get(key);
		return value ? value.split(/\s+/).filter(Boolean) : [...fallback];
	};
	return {
		alias,
		hostname,
		port: Number.isInteger(port) && port > 0 ? port : 22,
		user: values.get('user') ?? localUser,
		identityFiles: identityFiles.length ? identityFiles : PARADIS_DEFAULT_IDENTITY_FILES,
		identitiesOnly: values.get('identitiesonly')?.toLowerCase() === 'yes',
		identityAgent: values.get('identityagent'),
		proxyCommand: noneToUndefined(values.get('proxycommand')),
		proxyJump: noneToUndefined(values.get('proxyjump')),
		hostKeyAlias: noneToUndefined(values.get('hostkeyalias')),
		userKnownHostsFiles: knownHosts('userknownhostsfile', PARADIS_DEFAULT_USER_KNOWN_HOSTS),
		globalKnownHostsFiles: knownHosts('globalknownhostsfile', PARADIS_DEFAULT_GLOBAL_KNOWN_HOSTS),
	};
}

/** `Include` の行なら、そのパターン（空白区切り）を返す。 */
export function paradisSshIncludePatterns(line: string): readonly string[] | undefined {
	const match = /^\s*include(?:\s*=\s*|\s+)(?<value>.+)$/i.exec(line);
	return match?.groups ? tokenizeSSHPathList(match.groups.value.replace(/\s+#.*$/, '')).map(token => token.path) : undefined;
}

// --- 失敗の理由 ------------------------------------------------------------------------------------

/** 繋げなかった理由。node から renderer へは名前だけを渡し、文言は renderer で作る。 */
export type ParadisSftpFailureReason =
	/** 鍵で入れない（パスワード・2 段階認証が要る、使える鍵が無い）。 */
	| 'authUnsupported'
	/** ProxyJump を使う（段階 2）。 */
	| 'proxyJump'
	/** known_hosts にこのホストの鍵が無い。 */
	| 'hostKeyUnknown'
	/** known_hosts の鍵と違う（または失効）。 */
	| 'hostKeyMismatch'
	/** 名前を引けない・繋がらない。 */
	| 'unreachable'
	/** 応答が無い。 */
	| 'timeout'
	/** 接続の設定を読めない。 */
	| 'sshConfig'
	/** このウィンドウでユーザーが開いていないホスト。 */
	| 'notAllowed'
	| 'other';

const FAILURE_REASONS: readonly ParadisSftpFailureReason[] = ['authUnsupported', 'proxyJump', 'hostKeyUnknown', 'hostKeyMismatch', 'unreachable', 'timeout', 'sshConfig', 'notAllowed', 'other'];
const FAILURE_PREFIX = 'paradis-sftp:';

/** node 側で投げるエラーのメッセージ（理由だけを入れる。ホスト名・パスは入れない）。 */
export function paradisSftpFailureMessage(reason: ParadisSftpFailureReason): string {
	return `${FAILURE_PREFIX}${reason}`;
}

/** エラーが接続の失敗なら、その理由を返す。 */
export function paradisSftpFailureReasonOf(error: unknown): ParadisSftpFailureReason | undefined {
	const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
	if (!message) {
		return undefined;
	}
	const index = message.indexOf(FAILURE_PREFIX);
	if (index < 0) {
		return undefined;
	}
	const reason = message.slice(index + FAILURE_PREFIX.length).split(/\s/)[0] as ParadisSftpFailureReason;
	return FAILURE_REASONS.includes(reason) ? reason : 'other';
}

/** 画面に出す説明。 */
export function paradisDescribeSftpFailure(reason: ParadisSftpFailureReason, alias: string): string {
	switch (reason) {
		case 'authUnsupported':
			return localize('paradis.sftp.authUnsupported', "このホストはまだ対応していません（パスワード・2 段階認証が必要）。鍵ファイルか ssh-agent の鍵で入れるホストだけに直接送れます。");
		case 'proxyJump':
			return localize('paradis.sftp.proxyJump', "このホストはまだ対応していません（ProxyJump を使う接続）。「接続して開く」を使ってください。");
		case 'hostKeyUnknown':
			return localize('paradis.sftp.hostKeyUnknown', "{0} のホストの鍵が known_hosts にありません。ターミナルで一度 ssh {0} を実行して、鍵を確かめてから開いてください。", alias);
		case 'hostKeyMismatch':
			return localize('paradis.sftp.hostKeyMismatch', "{0} のホストの鍵が known_hosts と違うため、接続をやめました。ターミナルで一度 ssh {0} を実行して確認してください。", alias);
		case 'unreachable':
			return localize('paradis.sftp.unreachable', "{0} に繋がりませんでした。ホスト名とネットワークを確かめてください。", alias);
		case 'timeout':
			return localize('paradis.sftp.timeout', "{0} から応答がありませんでした。", alias);
		case 'sshConfig':
			return localize('paradis.sftp.sshConfig', "{0} の接続の設定を読めませんでした（~/.ssh/config）。", alias);
		case 'notAllowed':
			return localize('paradis.sftp.notAllowed', "{0} はこのウィンドウで開いていないため、読み書きしません。ファイル転送の画面からホストを開いてください。", alias);
		default:
			return localize('paradis.sftp.other', "{0} に SSH で接続できませんでした。", alias);
	}
}

// --- チャネルの型 ----------------------------------------------------------------------------------

/** `open` の結果。失敗は理由だけを返す。 */
export type IParadisSftpOpenResult =
	| { readonly ok: true; readonly home: string }
	| { readonly ok: false; readonly reason: ParadisSftpFailureReason };

/** 1 項目の情報（`list` の 1 行。権限の一覧と同じ形）。 */
export interface IParadisSftpEntry {
	readonly name: string;
	readonly mode: number;
	readonly kind: 'file' | 'directory' | 'symlink' | 'other';
	readonly isDirectory: boolean;
	readonly size: number;
	/** ミリ秒。 */
	readonly mtime: number;
}

/** 置き換えてよいかの判断に使う情報（`statFile`）。 */
export interface IParadisSftpFileInfo {
	readonly mode: number;
	readonly ownedByMe: boolean;
	readonly isDirectory: boolean;
	readonly isSymbolicLink: boolean;
}

// --- URI と経路 ------------------------------------------------------------------------------------

export function paradisIsSftpResource(resource: URI): boolean {
	return resource.scheme === PARADIS_SFTP_SCHEME;
}

/** 別名と接続先の絶対パスから URI を作る。 */
export function paradisSftpUri(alias: string, path: string): URI {
	return URI.from({ scheme: PARADIS_SFTP_SCHEME, authority: alias, path: path.startsWith('/') ? path : `/${path}` });
}

/**
 * そのホストへ、このウィンドウの接続を使うか、SSH を直接張るか。
 * このウィンドウが `ssh-remote+<別名>` で繋がっていれば今の接続（vscode-remote://）を使い、接続を増やさない。
 */
export function paradisDirectTargetFor(alias: string, remoteAuthority: string | undefined): 'window' | 'sftp' {
	return !!remoteAuthority && remoteAuthority === `ssh-remote+${alias.trim()}` ? 'window' : 'sftp';
}
