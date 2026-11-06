/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// Codex のペインで、画面に出ている会話（表の会話）を hook から決める。
//
// Codex 0.167.0 から、`--no-daemon` の TUI でも command center（`/agents`）で会話を切り替えられ、裏へ回した会話も
// 動き続ける。裏の会話の hook も同じプロセスから同じ env（ペインのトークン）で届くので、所有者の判定では表と
// 区別できない。2026-11-07 に 0.167.0 を偽のモデルで動かして確かめた順（テストの固定データ）:
//   A で送る → `←` で command center → 新しい会話 B で送る → A の Stop が B を表にしたまま届く。
//   読み込み済みの会話を開くだけでは hook は来ない。閉じた会話を開いて送ると SessionStart（source `resume`）が来る。
//
// 利用者が表の会話でしか起こせない hook（UserPromptSubmit と、compact 以外の SessionStart）だけで表の会話を決め、
// それ以外の hook で会話が違うものは「裏の会話」として扱う。command center で開いただけでまだ送っていない会話は、
// hook が来ないので、送るまでは前の会話が表のまま（開いた会話の hook は裏として扱われる）。子エージェントの hook は親の会話の session_id で届く
// （codex-rs/core/src/agent/control.rs の `session_id` は木全体で同じ）ので、親と同じ側に入る。
// 裏の会話の承認待ち（PermissionRequest）だけは覚え、その会話の次の hook か、Codex の終了（端末の状態の clear）で外す。

/** 表の会話を決める hook か。compact の SessionStart は裏の会話の自動の要約でも来るので数えない。 */
function setsFrontSession(event: string, source: string | undefined): boolean {
	return event === 'UserPromptSubmit' || (event === 'SessionStart' && source !== 'compact');
}

interface IParadisCodexPaneSessions {
	front: string;
	/** 裏の会話の session_id → 承認待ちに入った時刻。 */
	readonly backgroundWaits: Map<string, number>;
}

/** 1 つのペインの裏の会話の承認待ち。 */
export interface IParadisCodexBackgroundWait {
	readonly token: string;
	/** 最初に待ちに入った時刻。 */
	readonly since: number;
}

/**
 * Codex のペインごとの表の会話と、裏の会話の承認待ち。
 */
export class ParadisCodexFrontSessions {
	private readonly _panes = new Map<string, IParadisCodexPaneSessions>();

	/**
	 * hook 1 つを、表の会話のもの（`front`）か裏の会話のもの（`background`）に分ける。分けると同時に表の会話と
	 * 裏の承認待ちの記録を進める。session_id の無い hook は表とみなす。
	 *
	 * 台帳に無いペインでは、表を決める hook（UserPromptSubmit・compact 以外の SessionStart）が来るまで表を決めず、それまでの
	 * hook は今までどおり表として通す。Para Code の再起動後（ペインは pty daemon で生き残るが、ペインの会話の控えは残らない）に
	 * 最初に届いた hook が裏の会話のものでも、それを表に固定しないため。
	 *
	 * @param options.recordWait 裏の会話の承認待ちを覚えるか（控えの流し直しでは、画面で確かめていない待ちを覚えない）。
	 */
	classify(token: string, event: string, sessionId: string | undefined, source: string | undefined, at: number, options?: { readonly recordWait?: boolean }): 'front' | 'background' {
		if (sessionId === undefined || sessionId.length === 0) {
			return 'front';
		}
		const setsFront = setsFrontSession(event, source);
		let pane = this._panes.get(token);
		if (pane === undefined) {
			if (!setsFront) {
				return 'front';
			}
			pane = { front: sessionId, backgroundWaits: new Map() };
			this._panes.set(token, pane);
		}
		if (setsFront) {
			pane.front = sessionId;
			pane.backgroundWaits.delete(sessionId);
			return 'front';
		}
		if (sessionId === pane.front) {
			return 'front';
		}
		if (event === 'PermissionRequest') {
			if (options?.recordWait !== false && !pane.backgroundWaits.has(sessionId)) {
				pane.backgroundWaits.set(sessionId, at);
			}
		} else {
			pane.backgroundWaits.delete(sessionId);
		}
		return 'background';
	}

	/** 裏の会話が承認を待っているペイン。 */
	backgroundWaits(): IParadisCodexBackgroundWait[] {
		const waits: IParadisCodexBackgroundWait[] = [];
		for (const [token, pane] of this._panes) {
			if (pane.backgroundWaits.size > 0) {
				waits.push({ token, since: Math.min(...pane.backgroundWaits.values()) });
			}
		}
		return waits;
	}

	/** ペインの裏の承認待ちを捨てる（Codex が終わった。表の会話は残す）。消したものがあれば true。 */
	clearBackgroundWaits(token: string): boolean {
		const pane = this._panes.get(token);
		if (pane === undefined || pane.backgroundWaits.size === 0) {
			return false;
		}
		pane.backgroundWaits.clear();
		return true;
	}

	/** ペインの記録を捨てる（端末の終了・ペインの片付け）。 */
	forget(token: string): void {
		this._panes.delete(token);
	}

	clear(): void {
		this._panes.clear();
	}
}
