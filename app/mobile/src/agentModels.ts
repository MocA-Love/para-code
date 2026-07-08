// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * エージェントCLI（Claude Code / Codex）の選択可能モデルと、各モデルが対応する
 * reasoning effort の対応表（2026-07調査）。モデル/Effort変更シート（modelPill.tsx）の
 * 選択肢の供給源。変更の適用はPTYへの `/model <id>`・`/effort <level>` 注入で行うため、
 * id はそれぞれのCLIがコマンド引数として受け付ける表記にする。
 */

export interface AgentModelOption {
	/** `/model <id>` に渡す値（Claude: エイリアス、Codex: モデル名）。 */
	readonly id: string;
	readonly label: string;
	/** セッション情報(chat.info.model)との照合用の別名（正式ID等）。 */
	readonly aliases: readonly string[];
	/** このモデルで選択できる effort レベル（表示順）。 */
	readonly efforts: readonly string[];
}

const CLAUDE_MODELS: readonly AgentModelOption[] = [
	{ id: 'fable', label: 'Fable 5', aliases: ['claude-fable-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
	{ id: 'opus', label: 'Opus 4.8', aliases: ['claude-opus-4-8'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
	{ id: 'sonnet', label: 'Sonnet 5', aliases: ['claude-sonnet-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
	{ id: 'haiku', label: 'Haiku 4.5', aliases: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], efforts: ['low', 'medium', 'high'] },
];

const CODEX_MODELS: readonly AgentModelOption[] = [
	{ id: 'gpt-5.5', label: 'GPT-5.5', aliases: [], efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
	{ id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', aliases: [], efforts: ['none', 'low', 'medium', 'high', 'xhigh'] },
	{ id: 'gpt-5.4', label: 'GPT-5.4', aliases: [], efforts: ['none', 'low', 'medium', 'high'] },
	{ id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', aliases: [], efforts: ['none', 'low', 'medium', 'high'] },
];

/** agent種別（'claude' | 'codex'）に応じたモデル一覧。未知のagentは空配列。 */
export function agentModelOptions(agent: string | undefined): readonly AgentModelOption[] {
	if (agent === 'claude') {
		return CLAUDE_MODELS;
	}
	if (agent === 'codex') {
		return CODEX_MODELS;
	}
	return [];
}

/** セッション情報のモデル名（正式ID・エイリアスいずれも）から対応表のエントリを探す。 */
export function matchAgentModel(agent: string | undefined, model: string | undefined): AgentModelOption | undefined {
	if (model === undefined) {
		return undefined;
	}
	const lower = model.toLowerCase();
	return agentModelOptions(agent).find(option =>
		option.id === lower || option.aliases.some(alias => lower === alias || lower.startsWith(`${alias}-`)),
	);
}
