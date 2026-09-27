// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { useAppStore } from '../appState.js';
import type { TermStreamEvent } from '../store.js';
import type { TerminalViewport } from '../terminalViewport.js';

/**
 * 開発ビルド専用: PC とつながっていないシミュレータで、ターミナルの表示（xterm）に見本の出力を流す。
 *
 * `demo()`（`demoData.ts`）の後に呼ぶ（`globalThis.__paraDev.terminalDemo()`。`src/devProbe.tsx`）。
 * ストアのターミナルの操作（購読・付け直し・寸法の申告・入力）を、PC の代わりに答える偽物へ差し替える:
 *  - 購読すると、多数の行と末尾のプロンプトを持つスナップショットを返す。寸法は申告された値
 *    （設定「スマホの幅に合わせる」がオンのとき）か、ターミナルの PC 側の寸法
 *  - 寸法の申告が変わると、PC がリサイズしたのと同じく新しい寸法のスナップショットを送り直す
 *  - 入力欄から送った文字はプロンプトの後ろへそのまま映す（Enter で次のプロンプト）
 *
 * 末尾の3行には目印（「末尾から 3 行目」など）を付けてあるので、下端が隠れていないかを画面で見分けられる。
 * `__DEV__` でなければ何もしない。
 */

const listeners = new Map<string, Set<(ev: TermStreamEvent) => void>>();
let viewport: TerminalViewport | undefined;
let installed = false;

const PROMPT = '\x1b[35m~/para-code\x1b[0m \x1b[36mfeat/auth\x1b[0m\r\n\x1b[32m❯\x1b[0m ';

function sizeOf(terminalKey: string): { cols: number; rows: number } {
	const terminal = useAppStore.getState().workspace?.terminals.find(candidate => candidate.terminalKey === terminalKey);
	return {
		cols: viewport?.cols ?? terminal?.cols ?? 80,
		rows: viewport?.rows ?? terminal?.rows ?? 24,
	};
}

function sampleOutput(cols: number, rows: number): string {
	const lines: string[] = [];
	const total = rows + 30;
	for (let index = 1; index <= total; index++) {
		const fromEnd = total - index + 1;
		const text = fromEnd <= 3
			? `\x1b[33m[末尾から ${fromEnd} 行目]\x1b[0m pnpm test ${index}`
			: `\x1b[32m✓\x1b[0m step ${String(index).padStart(3, '0')} building module-${index} ${'.'.repeat(40)}`;
		lines.push(text.slice(0, cols + 9));
	}
	return `${lines.join('\r\n')}\r\n${PROMPT}`;
}

function emit(terminalKey: string, ev: TermStreamEvent): void {
	for (const listener of listeners.get(terminalKey) ?? []) {
		listener(ev);
	}
}

function snapshot(terminalKey: string): TermStreamEvent {
	const { cols, rows } = sizeOf(terminalKey);
	return { kind: 'snapshot', data: sampleOutput(cols, rows), cols, rows };
}

/** 見本の出力をターミナルの表示に流す（開発ビルドだけ）。 */
export function installTerminalDemo(): void {
	if (!__DEV__ || installed) {
		return;
	}
	installed = true;
	const echo = (terminalKey: string, text: string, execute: boolean) => {
		emit(terminalKey, { kind: 'data', data: execute ? `${text}\r\n${PROMPT}` : text });
	};
	useAppStore.setState({
		subscribeTerminal: (terminalKey, listener) => {
			let set = listeners.get(terminalKey);
			if (set === undefined) {
				set = new Set();
				listeners.set(terminalKey, set);
			}
			set.add(listener);
			listener(snapshot(terminalKey));
			return () => { set.delete(listener); };
		},
		attachTerminal: terminalKey => emit(terminalKey, snapshot(terminalKey)),
		detachTerminal: () => { },
		setTerminalViewport: next => {
			const changed = next?.cols !== viewport?.cols || next?.rows !== viewport?.rows;
			viewport = next;
			if (changed) {
				for (const terminalKey of listeners.keys()) {
					emit(terminalKey, snapshot(terminalKey));
				}
			}
		},
		sendInput: async (terminalKey, data) => {
			echo(terminalKey, data === '\r' ? '' : data, data === '\r');
			return true;
		},
		sendTextInput: async (terminalKey, text, execute) => {
			echo(terminalKey, text, execute);
			return true;
		},
	});
}
