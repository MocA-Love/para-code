// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { BotScreen } from '../../../../src/features/bots/botScreen.js';

/** Bot のページ（`/pc/[pcId]/bot/[botId]`。`bots.page.v1`）。iPad の 2 列では詳細の列に入る。 */
export default function BotRoute() {
	return <BotScreen />;
}
