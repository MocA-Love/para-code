/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { URI } from '../../../../base/common/uri.js';
import type { IParadisResumeAgentInWorkspaceRequest } from '../../workspaceSwitch/electron-browser/paradisWorktreeHeadlessCreate.js';
import { ParadisResumeAgent } from '../common/paradisSessionResume.js';

export interface IParadisSessionResumeEditorTarget {
	readonly rootUri: URI;
	readonly stateKey: string;
	readonly agent: ParadisResumeAgent;
	readonly sessionId: string;
	readonly currentSpace: boolean;
}

export interface IParadisSessionResumeEditorOptions {
	readonly mode: 'foreground' | 'background';
	readonly dangerouslyBypassPermissions: boolean;
}

export type ParadisSessionResumeEditorAction = 'background' | 'primary' | 'dangerous';

/** Editor上の各ボタンを、実行するresumeの種類へ変換する。 */
export function paradisSessionResumeEditorActionOptions(action: ParadisSessionResumeEditorAction): IParadisSessionResumeEditorOptions {
	if (action === 'background') {
		return { mode: 'background', dangerouslyBypassPermissions: false };
	}
	return { mode: 'foreground', dangerouslyBypassPermissions: action === 'dangerous' };
}

export interface IParadisSessionResumeEditorDependencies {
	switchToStateKey(stateKey: string): Promise<void>;
	resumeAgent(request: IParadisResumeAgentInWorkspaceRequest): Promise<void>;
}

/**
 * Session Resume editor のアクションを、スペース切り替えとCLI起動の順に実行する。
 * 別スペースのバックグラウンド再開はワークスペース(ウィンドウ)を切り替えず、foregroundだけ先に切り替える。
 * これはワークスペースの切り替えに関する挙動であり、呼び出し元のセッション履歴ダイアログ自体は
 * mode に関わらず（background でも）成功後に閉じる（paradisSessionResumeDialog.ts の resume() 参照）。
 */
export async function paradisResumeSessionFromEditor(
	target: IParadisSessionResumeEditorTarget,
	options: IParadisSessionResumeEditorOptions,
	dependencies: IParadisSessionResumeEditorDependencies,
): Promise<void> {
	if (!target.currentSpace && options.mode === 'foreground') {
		await dependencies.switchToStateKey(target.stateKey);
	}
	await dependencies.resumeAgent({
		rootUri: target.rootUri,
		stateKey: target.stateKey,
		agent: target.agent,
		sessionId: target.sessionId,
		dangerouslyBypassPermissions: options.dangerouslyBypassPermissions,
	});
}
