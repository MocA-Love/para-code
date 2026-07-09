// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * Claude Codeの選択可能モデルとreasoning effortの対応表。
 * Codexはapp-serverのmodel/listを正本にして動的取得するため、ここへ固定値を置かない。
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

/** agent種別（'claude' | 'codex'）に応じたモデル一覧。未知のagentは空配列。 */
export function agentModelOptions(agent: string | undefined): readonly AgentModelOption[] {
	if (agent === 'claude') {
		return CLAUDE_MODELS;
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
