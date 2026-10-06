/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 共有プロセス（CDP ゲートウェイ・入力キュー・DevTools の中継）から main の診断へ渡す印の形。
// IPC を渡るので、main は必ず paradisParseBrowserDiagnosticNote で読み直す。

/** 共有プロセスから main の `noteExactViewDiagnostic` へ渡す印。 */
export type IParadisBrowserDiagnosticNote =
	/** そのタブへのエージェントの CDP 接続数か、`Emulation.setFocusEmulationEnabled` の値が変わった。 */
	| { readonly kind: 'agent-state'; readonly connections?: number; readonly focusEmulation?: boolean }
	/** 入力キューの停止・再開・破棄・飽和（#246）。 */
	| { readonly kind: 'input-queue'; readonly queueKind: 'paused' | 'resumed' | 'abandoned' | 'saturated'; readonly cause?: string; readonly method?: string }
	/** para-browser のツールの失敗。値はどれも固定の語。 */
	| { readonly kind: 'tool-failure'; readonly tool: string; readonly errorKind: string; readonly gateReason?: string };

const WORD = /^[A-Za-z0-9_.:-]{1,64}$/;
const QUEUE_KINDS: ReadonlySet<string> = new Set(['paused', 'resumed', 'abandoned', 'saturated']);

function word(value: unknown): string | undefined {
	return typeof value === 'string' && WORD.test(value) ? value : undefined;
}

/** IPC で届いた値を読み直す。形が違えば undefined（診断は捨てるだけ）。 */
export function paradisParseBrowserDiagnosticNote(value: unknown): IParadisBrowserDiagnosticNote | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	switch (record.kind) {
		case 'agent-state': {
			const connections = typeof record.connections === 'number' && Number.isFinite(record.connections) ? Math.min(Math.max(0, Math.floor(record.connections)), 1_000) : undefined;
			const focusEmulation = typeof record.focusEmulation === 'boolean' ? record.focusEmulation : undefined;
			return connections === undefined && focusEmulation === undefined ? undefined : { kind: 'agent-state', connections, focusEmulation };
		}
		case 'input-queue': {
			const queueKind = typeof record.queueKind === 'string' && QUEUE_KINDS.has(record.queueKind) ? record.queueKind as 'paused' | 'resumed' | 'abandoned' | 'saturated' : undefined;
			return queueKind ? { kind: 'input-queue', queueKind, cause: word(record.cause), method: word(record.method) } : undefined;
		}
		case 'tool-failure': {
			const tool = word(record.tool);
			const errorKind = word(record.errorKind);
			return tool && errorKind ? { kind: 'tool-failure', tool, errorKind, gateReason: word(record.gateReason) } : undefined;
		}
		default:
			return undefined;
	}
}
