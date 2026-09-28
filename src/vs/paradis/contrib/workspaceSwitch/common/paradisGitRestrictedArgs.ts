/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * `runGit`（モバイル中継の許可リスト付き git 実行）で、リモートとやり取りするサブコマンドに掛ける追加の検査（Orca W2-15）。
 *
 * 許可リストの他のサブコマンドは「危険なオプションを拒否する」方式だが、これらは**許すオプションを列挙する**方式にする。
 * `--force` 系・`-f`・`+` 付きの refspec（強制更新）・`:branch`（リモートのブランチの削除）・`--mirror` / `--delete` /
 * `--all` などを、短いオプションの束ね（`-fu`）も含めて漏れなく弾くため（Q114 A: 強制 push はスマホからさせない）。
 * URL を remote として渡させない（`ext::` などの転送を名指しさせない）ために、`::` と `://` を含む引数も拒む。
 */

const ALLOWED_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
	push: new Set(['--porcelain', '--set-upstream', '-u', '--quiet', '-q']),
	fetch: new Set(['--quiet', '-q', '--prune']),
	pull: new Set(['--ff-only', '--no-rebase', '--quiet', '-q']),
};

/** 位置引数（remote と refspec）の数の上限。 */
const MAX_POSITIONAL: Readonly<Record<string, number>> = { push: 2, fetch: 1, pull: 2 };

/**
 * `args`（先頭がサブコマンド）を検査し、許されなければ理由を返す。対象外のサブコマンドは undefined。
 */
export function paradisRestrictedGitArgsError(args: readonly string[]): string | undefined {
	const [subcommand, ...rest] = args;
	if (subcommand === undefined) {
		return undefined;
	}
	const allowed = ALLOWED_OPTIONS[subcommand];
	if (allowed === undefined) {
		return undefined;
	}
	let positional = 0;
	for (const arg of rest) {
		if (arg.startsWith('-')) {
			if (!allowed.has(arg)) {
				return `${subcommand} option not allowed: ${arg}`;
			}
			continue;
		}
		positional++;
		if (arg.length === 0 || arg.startsWith('+') || arg.startsWith(':') || arg.includes('::') || arg.includes('://') || arg.includes('\0')) {
			return `${subcommand} argument not allowed: ${arg}`;
		}
		// refspec（`src:dst`）は push でだけ受ける。fetch / pull は remote とブランチの名前だけ
		if (arg.includes(':') && (subcommand !== 'push' || arg.endsWith(':') || arg.split(':').length !== 2)) {
			return `${subcommand} refspec not allowed: ${arg}`;
		}
	}
	if (positional > (MAX_POSITIONAL[subcommand] ?? 0)) {
		return `${subcommand}: too many arguments`;
	}
	if (subcommand === 'pull' && !rest.includes('--ff-only')) {
		// 合流のコミットも rebase も作らせない。進められなければ失敗させ、PC で解決してもらう
		return 'pull requires --ff-only';
	}
	return undefined;
}

/** リモートとやり取りする（ネットワークと認証を待つ）サブコマンド。 */
export const PARADIS_GIT_NETWORK_SUBCOMMANDS: ReadonlySet<string> = new Set(['push', 'fetch', 'pull']);
