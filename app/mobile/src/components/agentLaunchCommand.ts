// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 「新しいエージェントを起動」シートの純粋ロジック（React Native非依存。vitestで直接テストする）。
// コマンドプレビューはPC側 paradisWorktreeCreate.ts の paradisApplyPromptToTemplate と同じ
// プレースホルダ規則をなぞる（表示用のためクォートはPOSIX固定。実際のコマンド組み立ては
// PC側が実ターミナルのシェルに合わせて行う）。

import type { WorktreeAgentDef, WorktreeAgentModel } from '../store.js';

/** POSIXシェルの単一引数クォート（PC側 paradisQuotePosixShellArg と同じ規則）。 */
function quotePosixArg(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 選択中モデルで許可される effort id 一覧。undefined=モデル未選択（既定）、空配列=effort非対応。 */
export function allowedEfforts(agent: WorktreeAgentDef, model: WorktreeAgentModel | undefined): string[] | undefined {
	if (model === undefined) {
		return undefined;
	}
	if (model.efforts !== undefined) {
		return model.efforts;
	}
	return (agent.efforts ?? []).map(effort => effort.id);
}

/** PC側 paradisApplyPromptToTemplate と同じ規則でコマンドプレビューを組み立てる。 */
export function buildLaunchCommandPreview(agent: WorktreeAgentDef, prompt: string, flags: { model: string; effort: string; permission: string }): string {
	let command = agent.command ?? `${agent.id} {prompt}`;
	const leftoverFlags: string[] = [];
	for (const [placeholder, flag] of [['{model}', flags.model], ['{effort}', flags.effort], ['{permission}', flags.permission]] as const) {
		if (command.includes(placeholder)) {
			command = command.replace(placeholder, flag);
		} else if (flag.length > 0) {
			leftoverFlags.push(flag);
		}
	}
	if (leftoverFlags.length > 0) {
		const combined = leftoverFlags.join(' ');
		command = command.includes('{prompt}')
			? command.replace('{prompt}', `${combined} {prompt}`)
			: `${command} ${combined}`;
	}
	command = command.replace(/ {2,}/g, ' ').trim();
	const trimmedPrompt = prompt.trim().replace(/\s+/g, ' ');
	const promptExpression = trimmedPrompt.length === 0
		? ''
		: quotePosixArg(trimmedPrompt.length > 40 ? `${trimmedPrompt.slice(0, 40)}…` : trimmedPrompt);
	command = command.includes('{prompt}')
		? command.replace('{prompt}', promptExpression)
		: (promptExpression.length > 0 ? `${command} ${promptExpression}` : command);
	return command.replace(/ {2,}/g, ' ').trim();
}
