/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// スキルファイルの設置（O4）で、shared process（書き込み）と画面（確認ダイアログ）が共有する型。

export type ParadisAgentIdeSkillAgent = 'claude' | 'codex';

/** 設置先の今の状態。 */
export type ParadisAgentIdeSkillState = 'missing' | 'same' | 'different' | 'notAFile';

export interface IParadisAgentIdeSkillTarget {
	readonly agent: ParadisAgentIdeSkillAgent;
	readonly path: string;
}

export interface IParadisAgentIdeSkillInspection extends IParadisAgentIdeSkillTarget {
	readonly state: ParadisAgentIdeSkillState;
	/** 既にあるファイルの中身の指紋（上書きの確認をした後に変わっていないかを比べる）。 */
	readonly fingerprint?: string;
}

export type ParadisAgentIdeSkillOutcome = 'installed' | 'overwritten' | 'unchanged' | 'skipped' | 'failed';

export interface IParadisAgentIdeSkillInstallResult extends IParadisAgentIdeSkillTarget {
	readonly outcome: ParadisAgentIdeSkillOutcome;
	readonly detail?: string;
}

export interface IParadisAgentIdeSkillInstallRequest {
	readonly agent: ParadisAgentIdeSkillAgent;
	/** 中身の違う既存ファイルを上書きしてよいか（利用者が確かめた場合だけ true）。 */
	readonly overwrite: boolean;
	/** 上書きするとき、利用者が確かめたときの中身の指紋（`inspect` の `fingerprint`）。 */
	readonly expectedFingerprint?: string;
}

/** 調べた結果を「新しく作るもの」「上書きの確認が要るもの」に分ける。 */
export function paradisAgentIdeSkillInstallPlan(inspections: readonly IParadisAgentIdeSkillInspection[]): { readonly missing: readonly IParadisAgentIdeSkillInspection[]; readonly different: readonly IParadisAgentIdeSkillInspection[] } {
	return {
		missing: inspections.filter(inspection => inspection.state === 'missing'),
		different: inspections.filter(inspection => inspection.state === 'different'),
	};
}
