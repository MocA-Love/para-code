/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { paradisParseTranscriptEntry } from './paradisPersistedAgentActivity.js';

/** 読むのに要る FileHandle の形（テストでは fake を渡す）。 */
export interface IParadisTranscriptFile {
	stat(): Promise<{ readonly size: number; readonly dev: number; readonly ino: number }>;
	read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>;
}

interface ILine {
	/** 行の先頭のバイト位置。 */
	readonly start: number;
	/** 行末の改行のバイト位置。 */
	readonly newline: number;
	readonly entry: Record<string, unknown> | undefined;
}

interface IWindowState {
	readonly dev: number;
	readonly ino: number;
	/** ここまで（最後の改行の次）を読んだ。続きはここから読む。 */
	end: number;
	/** end が行の途中（末尾の窓に改行が無かった）。続きの最初の改行までは書きかけの行の残りとして捨てる。 */
	midLine: boolean;
	/** 先頭の数行の指紋（同じ大きさ以上に書き直されたのを見分ける）。 */
	readonly fingerprint: Buffer;
	/** 先頭の窓の行。ファイルが「先頭＋末尾」を超えてから固める（それまでは lines に全部ある）。 */
	head: readonly ILine[] | undefined;
	/** 覚えている行（固める前は先頭から全部、固めた後は末尾の窓の中だけ）。 */
	lines: ILine[];
	bytes: number;
	/** 覚えている量（先頭の窓を含む。予算の勘定用）。 */
	cost: number;
}

const FINGERPRINT_BYTES = 64;

/**
 * 会話ログ（Claude Code・Codex の JSONL）を「先頭 headBytes ＋ 末尾 tailBytes」の窓で読み、解いた行を返す。
 *
 * hook のたびに同じログを読むので、ファイルごとに読んだ位置と解いた行を覚え、2 回目からは増えた分だけ読んで解く。
 * 返す行は、毎回ファイル全体を窓で読み直していたとき（先頭の窓は最後の書きかけの行を落とし、末尾の窓は最初の
 * 書きかけの行を落とす。ファイルの最後の書きかけの行は含める）と同じになる。切り詰め・置き換え（dev・ino・先頭の
 * 指紋が変わる、読んだ位置より小さくなる）を見たら最初から読み直す。覚える量は全ファイルで budgetBytes まで
 * （古く使ったものから忘れる）。
 */
export class ParadisTranscriptEntryWindows {
	private readonly states = new Map<string, IWindowState>();
	private totalBytes = 0;

	constructor(
		private readonly headBytes: number,
		private readonly tailBytes: number,
		private readonly budgetBytes: number,
	) { }

	/** `path` を開いた `file`（呼び出し側が許可を確かめたもの）から、窓の中の解いた行を返す。 */
	async read(path: string, file: IParadisTranscriptFile): Promise<Record<string, unknown>[]> {
		const { size, dev, ino } = await file.stat();
		const previous = this.states.get(path);
		this.forget(path);
		if (size <= 0) {
			return [];
		}
		let state = previous !== undefined && previous.dev === dev && previous.ino === ino && size >= previous.end
			&& await this.sameFile(file, previous) ? previous : undefined;
		if (state === undefined) {
			state = await this.initialState(file, size, dev, ino);
		}
		// 続きを読む。最後の改行より後は書きかけなので覚えず、今回の分にだけ使う
		let partial: ILine | undefined;
		if (size > state.end) {
			const start = state.end;
			const buffer = Buffer.alloc(size - start);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
			const body = buffer.subarray(0, bytesRead);
			let lineStart = 0;
			for (let newline = body.indexOf(0x0a); newline >= 0; newline = body.indexOf(0x0a, lineStart)) {
				if (state.midLine) {
					state.midLine = false;
				} else if (newline > lineStart) {
					state.lines.push(this.line(body, lineStart, newline, start));
					state.bytes += newline - lineStart;
				}
				lineStart = newline + 1;
			}
			state.end = state.midLine ? start + body.length : start + lineStart;
			if (!state.midLine && lineStart < body.length) {
				partial = this.line(body, lineStart, body.length, start);
			}
		}
		const result = this.window(state, size, partial);
		this.remember(path, state);
		return result;
	}

	/** ペインが閉じた等で要らなくなったファイルを忘れる。 */
	forget(path: string): void {
		const state = this.states.get(path);
		if (state !== undefined) {
			this.states.delete(path);
			this.totalBytes -= state.cost;
		}
	}

	private line(body: Buffer, from: number, to: number, offset: number): ILine {
		return { start: offset + from, newline: offset + to, entry: paradisParseTranscriptEntry(body.toString('utf8', from, to)) };
	}

	/** 前に読んだのと同じファイルか（先頭の指紋が同じで、読んだ位置の直前が改行のまま）。 */
	private async sameFile(file: IParadisTranscriptFile, state: IWindowState): Promise<boolean> {
		const fingerprint = Buffer.alloc(state.fingerprint.length);
		const { bytesRead } = await file.read(fingerprint, 0, fingerprint.length, 0);
		if (bytesRead !== fingerprint.length || !fingerprint.equals(state.fingerprint)) {
			return false;
		}
		if (state.end === 0 || state.midLine) {
			return true;
		}
		const last = Buffer.alloc(1);
		return (await file.read(last, 0, 1, state.end - 1)).bytesRead === 1 && last[0] === 0x0a;
	}

	/** 初めて読む（または読み直す）ファイル。大きければ先頭と末尾の窓だけを読む。 */
	private async initialState(file: IParadisTranscriptFile, size: number, dev: number, ino: number): Promise<IWindowState> {
		const fingerprintBuffer = Buffer.alloc(Math.min(FINGERPRINT_BYTES, size));
		await file.read(fingerprintBuffer, 0, fingerprintBuffer.length, 0);
		const state: IWindowState = { dev, ino, end: 0, midLine: false, fingerprint: fingerprintBuffer, head: undefined, lines: [], bytes: 0, cost: 0 };
		if (size <= this.headBytes + this.tailBytes) {
			return state; // 全部を続きとして読む
		}
		// 先頭の窓: 窓の中で改行まで書かれた行だけ
		const head = Buffer.alloc(this.headBytes);
		const headRead = (await file.read(head, 0, head.length, 0)).bytesRead;
		const headLines: ILine[] = [];
		let lineStart = 0;
		for (let newline = head.indexOf(0x0a); newline >= 0 && newline < headRead; newline = head.indexOf(0x0a, lineStart)) {
			if (newline > lineStart) {
				headLines.push(this.line(head, lineStart, newline, 0));
			}
			lineStart = newline + 1;
		}
		state.head = headLines;
		// 末尾の窓は最初の書きかけの行を落とすので、窓の始まりから続きとして読み、最初の改行までを捨てる
		state.end = size - this.tailBytes;
		state.midLine = true;
		return state;
	}

	/** 今の大きさでの窓の中の行（毎回全体を読んでいたときと同じ並び）。 */
	private window(state: IWindowState, size: number, partial: ILine | undefined): Record<string, unknown>[] {
		const entries: Record<string, unknown>[] = [];
		const push = (line: ILine) => {
			if (line.entry !== undefined) {
				entries.push(line.entry);
			}
		};
		if (size <= this.headBytes + this.tailBytes && state.head === undefined) {
			state.lines.forEach(push);
			if (partial !== undefined) { push(partial); }
			return entries;
		}
		if (state.head === undefined) {
			state.head = state.lines.filter(line => line.newline < this.headBytes);
		}
		// 末尾の窓に入るのは、窓の始まりより後で始まる行（始まりちょうどの行は書きかけとして落としていた）
		const tailStart = size - this.tailBytes;
		const kept = state.lines.filter(line => line.start > tailStart);
		if (kept.length !== state.lines.length) {
			state.lines = kept;
			state.bytes = kept.reduce((sum, line) => sum + line.newline - line.start, 0);
		}
		state.head.forEach(push);
		state.lines.forEach(push);
		if (partial !== undefined && partial.start > tailStart) { push(partial); }
		return entries;
	}

	private remember(path: string, state: IWindowState): void {
		// 同じファイルを並んで読んだ分を数え直さない
		this.forget(path);
		state.cost = state.bytes + (state.head?.reduce((sum, line) => sum + line.newline - line.start, 0) ?? 0);
		if (state.cost > this.budgetBytes) {
			return;
		}
		this.states.set(path, state);
		this.totalBytes += state.cost;
		for (const [oldPath] of this.states) {
			if (this.totalBytes <= this.budgetBytes) {
				break;
			}
			this.forget(oldPath);
		}
	}
}
