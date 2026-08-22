/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 前面で動いているものの名前から、シェルの種類を決める。
//
// **これがアプリ側にあることが、面を薄く保てている理由。** `TerminalShellType` は VS Code の型で、
// 種類が増えるたびに形が変わる（実際 1.130 の取り込みで `commandcode` が1つ増えた）。常駐へ
// 通していたら、そのたびに凍結が崩れていた。常駐から来るのは題名の**文字列**だけで、型に
// するのはここ。
//
// 判定は upstream の `TerminalProcess._sendProcessTitle` と同じにしてある。**揃っていないと、
// 同じシェルが常駐経由のときだけ違う種類として扱われる**（タブ名の `${sequence}`、シェル統合の
// 質、Quick Fix が影響を受ける）。upstream 側が変わったらここも合わせること。

import { basename } from '../../../../base/common/path.js';
import { GeneralShellType, PosixShellType, TerminalShellType } from '../../../../platform/terminal/common/terminal.js';

const POSIX_SHELLS = new Map<string, PosixShellType>([
	['bash', PosixShellType.Bash],
	['csh', PosixShellType.Csh],
	['fish', PosixShellType.Fish],
	['ksh', PosixShellType.Ksh],
	['sh', PosixShellType.Sh],
	['zsh', PosixShellType.Zsh],
]);

const GENERAL_SHELLS = new Map<string, GeneralShellType>([
	['claude', GeneralShellType.Claude],
	['codex', GeneralShellType.Codex],
	['commandcode', GeneralShellType.CommandCode],
	['copilot', GeneralShellType.Copilot],
	['gemini', GeneralShellType.Gemini],
	['pwsh', GeneralShellType.PowerShell],
	['powershell', GeneralShellType.PowerShell],
	['python', GeneralShellType.Python],
	['julia', GeneralShellType.Julia],
]);

/**
 * 題名からシェルの種類を読む。分からなければ undefined。
 *
 * この常駐は非 Windows でしか動かないので、パスは常に削る（upstream は Windows だけ削らない）。
 */
export function paradisShellTypeFromTitle(title: string): TerminalShellType | undefined {
	// fig が入っていると題名の末尾を書き換えるので、先に落とす。
	const name = basename(title.replace(/ \(figterm\)$/g, ''));
	const lower = name.toLowerCase();
	// python3 や julia-1.10 のように版が付くので、この2つだけ前方一致で見る。
	if (lower.startsWith('python')) {
		return GeneralShellType.Python;
	}
	if (lower.startsWith('julia')) {
		return GeneralShellType.Julia;
	}
	return POSIX_SHELLS.get(name) ?? GENERAL_SHELLS.get(name);
}
