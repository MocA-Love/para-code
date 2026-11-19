// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * エージェントの種類（claude・codex・opencode・antigravity）への問いの入口。
 *
 * 種類ごとの記述は PC と同じ表を使う（`paradisAgentDescriptor.ts` を直接 import する。import を持たない
 * 葉のファイルなので、`pcCompat.ts` と同じく相対パスでそのまま読める）。アプリの側で「どの種類が何をできるか」を
 * 別に書くと、種類が増えたときに PC とずれる。
 *
 * ここで答えるのは、その種類が「いつでも同じ」こと（呼び名と静的な性質）だけ。PC の版や、そのペインで mod が
 * 生きているかで変わること（`capabilities.agentActions`・`capabilities.claudeSettings`・`info.modelControl`）は
 * PC が配る値を読む。呼ぶ側は PC の値との組み合わせ方（どちらを先に見るか）を変えない。
 *
 * 引数は電文の値のまま（`string | undefined`）受ける。型に無い値・空文字・undefined は「どの種類でもない」。
 */

import { PARADIS_AGENT_DESCRIPTORS, paradisAgentDescriptor, type ParadisAgentKind } from '../../../src/vs/paradis/contrib/agentChat/common/paradisAgentDescriptor.js';

/** エージェント CLI の種類（PC の `ParadisAgentKind` と同じ）。 */
export type AgentKind = ParadisAgentKind;

/** 電文の値が、知っている種類か。 */
export function isAgentKind(agent: string | undefined): agent is AgentKind {
	return paradisAgentDescriptor(agent) !== undefined;
}

/** 画面に出す名前（Claude Code・Codex・OpenCode・Antigravity CLI）。知らない種類は undefined。 */
export function agentDisplayName(agent: string | undefined): string | undefined {
	return paradisAgentDescriptor(agent)?.displayName;
}

/** 通知の副題などの短い名前（Claude・Codex・OpenCode・Antigravity）。知らない種類は undefined。 */
export function agentShortName(agent: string | undefined): string | undefined {
	return paradisAgentDescriptor(agent)?.shortName;
}

/** アプリから起動する 2 種（Claude Code・Codex）の短い名前。claude 以外は Codex の名前。 */
export function launchAgentShortName(agent: string): string {
	return agent === 'claude' ? PARADIS_AGENT_DESCRIPTORS.claude.shortName : PARADIS_AGENT_DESCRIPTORS.codex.shortName;
}

/** 中断を端末の Ctrl+C ではなく、PC の連携の API へ頼む種類か（OpenCode）。 */
export function agentInterruptsViaApi(agent: string | undefined): boolean {
	return paradisAgentDescriptor(agent)?.interrupt === 'api';
}

/** モデル・effort をチャット欄から変える口を持つ種類か（Claude Code）。実際に変えられるかは PC の `claudeSettings` も要る。 */
export function agentHasModelControl(agent: string | undefined): boolean {
	return paradisAgentDescriptor(agent)?.modelControl === 'mod-or-keys';
}

/** PC で開いている画面（`panel`）を持つ種類か。 */
export function agentHasPanel(agent: string | undefined): boolean {
	return paradisAgentDescriptor(agent)?.features.panel === true;
}

/** PC の入力欄の下書き（`pcDraft`）を持つ種類か。 */
export function agentHasPcDraft(agent: string | undefined): boolean {
	return paradisAgentDescriptor(agent)?.features.pcDraft === true;
}
