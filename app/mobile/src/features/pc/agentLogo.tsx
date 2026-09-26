// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { Sparkles, SquareTerminal } from 'lucide-react-native';
import { ProviderLogo } from '../../components/providerLogo.js';
import { colors } from '../../theme.js';
import { Icon } from '../../ui/index.js';
import type { AgentLogoKind } from './agentRowLine.js';

/**
 * 行の頭のエージェントのロゴ（モックの `AG()`）。Claude / Codex は既存のロゴ（セッションのタブと同じ
 * `ProviderLogo`）、それ以外のエージェントは星、ターミナルは端末のアイコン。
 */
export function AgentLogo({ kind, size }: { kind: AgentLogoKind; size: number }) {
	if (kind === 'claude' || kind === 'codex') {
		return <ProviderLogo provider={kind} size={size} />;
	}
	return <Icon icon={kind === 'terminal' ? SquareTerminal : Sparkles} size={size} color={colors.textDim} />;
}
