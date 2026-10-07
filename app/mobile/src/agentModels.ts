// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { WorktreeAgentDef } from './store.js';

/**
 * Claude Codeの選択可能モデルとreasoning effortの対応表。
 * 正本はPCがインストール済みの Claude Code から取った一覧（`worktreeForm` の agents）で、
 * ここの固定表はそれが届く前と、届かない古いPCのときにだけ使う。
 * Codexはapp-serverのmodel/listを正本にして動的取得するため、ここへ固定値を置かない。
 */

export interface AgentModelOption {
	/** `/model <id>` に渡す値（Claude: エイリアス、Codex: モデル名）。 */
	readonly id: string;
	readonly label: string;
	/** セッション情報(chat.info.model)との照合用の正式ID（完全一致で比べる。末尾の日付と `[1m]` は外して比べる）。 */
	readonly aliases: readonly string[];
	/** このモデルで選択できる effort レベル（表示順）。空配列 = effort 非対応。 */
	readonly efforts: readonly string[];
}

const CLAUDE_EFFORTS: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Claude Code 2.1.293 で別名が指す先（2026-10-08）。 */
const CLAUDE_MODELS: readonly AgentModelOption[] = [
	{ id: 'fable', label: 'Fable 5.1', aliases: ['claude-fable-5-1'], efforts: CLAUDE_EFFORTS },
	{ id: 'opus', label: 'Opus 5.5', aliases: ['claude-opus-5-5'], efforts: CLAUDE_EFFORTS },
	{ id: 'sonnet', label: 'Sonnet 5.5', aliases: ['claude-sonnet-5-5'], efforts: CLAUDE_EFFORTS },
	{ id: 'haiku', label: 'Haiku 5.5', aliases: ['claude-haiku-5-5'], efforts: CLAUDE_EFFORTS },
];

/**
 * agent種別（'claude' | 'codex'）に応じたモデル一覧。未知のagentは空配列。
 * `claudeCatalog` はPCから届いたClaudeの候補（{@link claudeModelOptionsFromAgents}）。空なら固定表を使う。
 */
export function agentModelOptions(agent: string | undefined, claudeCatalog?: readonly AgentModelOption[]): readonly AgentModelOption[] {
	if (agent === 'claude') {
		return claudeCatalog !== undefined && claudeCatalog.length > 0 ? claudeCatalog : CLAUDE_MODELS;
	}
	return [];
}

/** 照合用にモデルIDから末尾の `[1m]` と日付を外す（`claude-haiku-4-5-20251001` → `claude-haiku-4-5`）。 */
function normalizeModelId(model: string): string {
	return model.trim().toLowerCase().replace(/\[[a-z0-9]+\]$/, '').replace(/-\d{8}$/, '');
}

/**
 * セッション情報のモデル名（正式ID・エイリアスいずれも）から対応表のエントリを探す。
 * 前方一致はしない（`claude-opus-5` の行が `claude-opus-5-5` に当たって「Opus 5」と出ていた）。
 * 別名そのもの → 正式IDの完全一致 → 日付と `[1m]` を外した一致、の順で探す。
 */
export function matchAgentModel(agent: string | undefined, model: string | undefined, options: readonly AgentModelOption[] = agentModelOptions(agent)): AgentModelOption | undefined {
	if (model === undefined || model.trim().length === 0) {
		return undefined;
	}
	const lower = model.trim().toLowerCase();
	const normalized = normalizeModelId(model);
	return options.find(option => option.id.toLowerCase() === lower)
		?? options.find(option => option.aliases.some(alias => alias.toLowerCase() === lower))
		?? options.find(option => option.aliases.some(alias => normalizeModelId(alias) === normalized));
}

/**
 * Claude の正式なモデルIDから版つきの名前を作る（`claude-opus-5-5` → `Opus 5.5`、
 * `claude-haiku-4-5-20251001` → `Haiku 4.5`）。形が違えば undefined。
 * PC側 `paradisClaudeModelDisplayName` と同じ規則。
 */
export function claudeModelDisplayName(model: string): string | undefined {
	const match = /^claude-(?<family>[a-z]+)-(?<major>\d+)(?:-(?<minor>\d{1,2}))?(?:-\d{8})?(?:\[(?<suffix>[a-z0-9]+)\])?$/i.exec(model.trim());
	const { family, major, minor, suffix } = match?.groups ?? {};
	if (family === undefined || major === undefined) {
		return undefined;
	}
	const name = `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor !== undefined ? `.${minor}` : ''}`;
	return suffix !== undefined ? `${name} · ${suffix.toUpperCase()}` : name;
}

/**
 * PCから届いたエージェント定義から、Claudeのモデル候補を作る。使えなければ undefined（固定表を使う）。
 *
 * 使うのは、PCがインストール済みの Claude Code から一覧を取れたとき（候補に正式ID `resolvedModel` が
 * 付いている）だけ。正式IDの無い一覧（古いPC、設定で固定した一覧）は、版の書かれたラベルが今の CLI と
 * ずれていても確かめようがないので使わない。PCのラベルは `opus (Opus 5.5)` の形なので、括弧の中だけを名前にする。
 */
export function claudeModelOptionsFromAgents(agents: readonly WorktreeAgentDef[] | undefined): AgentModelOption[] | undefined {
	const claude = agents?.find(agent => agent.id === 'claude');
	if (claude?.models === undefined || !claude.models.some(model => typeof model.resolvedModel === 'string' && model.resolvedModel.length > 0)) {
		return undefined;
	}
	const vocabulary = claude.efforts?.map(effort => effort.id) ?? CLAUDE_EFFORTS;
	return claude.models.map(model => {
		const resolved = typeof model.resolvedModel === 'string' && model.resolvedModel.length > 0 ? model.resolvedModel : undefined;
		const inner = model.label !== undefined && model.label.startsWith(`${model.id} (`) && model.label.endsWith(')')
			? model.label.slice(model.id.length + 2, -1).trim()
			: undefined;
		const label = inner || model.label || (resolved !== undefined ? claudeModelDisplayName(resolved) : undefined) || model.id;
		return {
			id: model.id,
			label,
			aliases: resolved !== undefined ? [resolved] : [],
			efforts: model.efforts ?? vocabulary,
		};
	});
}
