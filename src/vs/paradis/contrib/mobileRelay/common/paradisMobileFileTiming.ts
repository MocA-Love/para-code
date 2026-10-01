/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { ParadisSpanAttributes, runInParadisSpan } from '../../sentry/common/paradisSentryDiagnostics.js';

/** モバイルのファイルビューアが使う fs 要求の種類。これ以外（list・find 等）は測らない。 */
export type ParadisMobileFileTimingKind = 'read' | 'xlsx' | 'pdf' | 'docx' | 'media';

/** 応答の結末。`too-large` は転送上限で弾いたもの。 */
export type ParadisMobileFileTimingOutcome = 'ok' | 'not-modified' | 'error' | 'too-large';

/** 区間の時間と、件数・サイズ・真偽の値を Sentry へ送る口。テストでは差し替える。 */
export type ParadisMobileFileTimingRecorder = (attributes: ParadisSpanAttributes) => void;

const TIMED_KINDS: ReadonlySet<string> = new Set<ParadisMobileFileTimingKind>(['read', 'xlsx', 'pdf', 'docx', 'media']);

/** 拡張子として送ってよい形。これ以外（長い・記号を含む）は名前の一部が漏れうるので `other` に畳む。 */
const SAFE_EXTENSION = /^[a-z0-9]{1,8}$/;

function recordWithSentry(attributes: ParadisSpanAttributes): void {
	runInParadisSpan('mobileFileViewer', 'pc', attributes, () => { });
}

/**
 * パスから拡張子だけを取り出す。パス・ファイル名は Sentry へ送らないため、拡張子以外の部分は
 * 返さない。拡張子が無ければ `none`、送ってよい形でなければ `other`。
 */
export function paradisMobileFileTimingExtension(path: string): string {
	const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
	const dot = name.lastIndexOf('.');
	if (dot <= 0) {
		return 'none';
	}
	const extension = name.slice(dot + 1).toLowerCase();
	return SAFE_EXTENSION.test(extension) ? extension : 'other';
}

/**
 * モバイルのファイルビューアの要求1件について、PC側の各区間の所要時間を測って1件の transaction
 * （`para.mobileFileViewer.pc`）として送る。
 *
 * renderer の Sentry は await を跨ぐと実行中の span を失うので、区間ごとに時刻だけ取っておき、
 * 応答を送り終えたところで1つの span にまとめて attribute を付ける（`workspaceSwitch.phases` と同じ形）。
 * 同じ区間名を2回測った場合は足し合わせる。到達しなかった区間は送らない（0 を送ると平均が歪む）。
 *
 * `safe_request_id` はモバイルが要求ごとに振る id（起動ごとの乱数 + 連番）で、アプリ側の
 * `para.mobileFileViewer.fetch` / `display` と突き合わせるために載せる。パスや内容は含まない。
 */
export class ParadisMobileFileTiming {
	private readonly phases: Record<string, number> = {};
	private readonly values: ParadisSpanAttributes = {};
	private last: number;
	private outcome: ParadisMobileFileTimingOutcome = 'ok';
	private finished = false;

	/**
	 * 測る対象の要求なら計測を始める。対象外（list・find 等）や id の無い要求なら undefined。
	 * `receivedAt` は fs チャネルの要求を受け取った時刻（JSON の解析より前）。
	 */
	static start(
		msg: { readonly t?: unknown; readonly id?: unknown; readonly path?: unknown; readonly highlight?: unknown },
		receivedAt: number,
		recorder: ParadisMobileFileTimingRecorder = recordWithSentry,
		now: () => number = Date.now,
	): ParadisMobileFileTiming | undefined {
		if (typeof msg.t !== 'string' || !TIMED_KINDS.has(msg.t) || typeof msg.id !== 'string') {
			return undefined;
		}
		return new ParadisMobileFileTiming(msg.t as ParadisMobileFileTimingKind, msg.id, typeof msg.path === 'string' ? msg.path : '', msg.highlight === true, receivedAt, recorder, now);
	}

	private constructor(
		private readonly kind: ParadisMobileFileTimingKind,
		private readonly requestId: string,
		path: string,
		highlight: boolean,
		private readonly receivedAt: number,
		private readonly recorder: ParadisMobileFileTimingRecorder,
		private readonly now: () => number,
	) {
		this.last = receivedAt;
		this.values.safe_ext = paradisMobileFileTimingExtension(path);
		if (kind === 'read') {
			this.values.safe_highlight = highlight;
		}
	}

	/** 直前の区切りからここまでを `phase` の時間として記録する。 */
	mark(phase: string): void {
		const at = this.now();
		const key = `safe_${phase}_ms` as const;
		this.phases[key] = (this.phases[key] ?? 0) + (at - this.last);
		this.last = at;
	}

	/** サイズ・件数・真偽を載せる。同じキーは上書き。 */
	set(values: ParadisSpanAttributes): void {
		Object.assign(this.values, values);
	}

	/** 結末を決める。送る前に何度呼んでもよく、最後の値が使われる。 */
	setOutcome(outcome: ParadisMobileFileTimingOutcome): void {
		this.outcome = outcome;
	}

	/**
	 * 応答のフレームを送り出した直後に呼ぶ。送出の時間を `send` として区切り、1件の transaction を送る。
	 * 2回目以降は何もしない。**計測の失敗で応答の経路を巻き込まないよう、ここでは投げない。**
	 */
	sent(replyBytes: number): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		try {
			this.mark('send');
			this.recorder({
				// id は相手（ペアリング済みのアプリ）が決める値なので、長さだけは抑えて載せる。
				safe_request_id: this.requestId.slice(0, 64),
				safe_kind: this.kind,
				safe_outcome: this.outcome,
				safe_total_ms: this.now() - this.receivedAt,
				safe_reply_bytes: replyBytes,
				...this.values,
				...this.phases,
			});
		} catch {
			// 計測は捨ててよい
		}
	}
}
