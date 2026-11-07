// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 繋ぎ直しで state を待たずに先出しした会話の attach の記録（`store.ts` の `sendSpeculativeAgentAttaches`）。
 * state が届いた後の張り直しでは、同じ PC のウィンドウ宛てに先出し済みのものを送り直さない（送り直すと PC は
 * 先出しの分を捨てて同じ応答をもう一度作る。epoch が変わった直後なら全量の snapshot が 2 回届く）。
 */
export class SpeculativeAgentAttaches {
	private readonly sent = new Set<string>();

	/** 先出しを始める（前の繋ぎ直しの記録を捨てる）。 */
	reset(): void {
		this.sent.clear();
	}

	add(terminalKey: string): void {
		this.sent.add(terminalKey);
	}

	/**
	 * 張り直しで送るものを返し、記録を空にする（張り直しのたびに 1 回だけ効かせる）。先出し済みで、宛先
	 * （`currentTarget`）が先出ししたときの宛先（`sentTarget`）と同じものだけ除く。
	 */
	takeResends(terminalKeys: Iterable<string>, currentTarget: (terminalKey: string) => string | undefined, sentTarget: (terminalKey: string) => string | undefined): string[] {
		const resends: string[] = [];
		for (const terminalKey of terminalKeys) {
			const target = currentTarget(terminalKey);
			if (!(this.sent.has(terminalKey) && target !== undefined && target === sentTarget(terminalKey))) {
				resends.push(terminalKey);
			}
		}
		this.sent.clear();
		return resends;
	}
}
