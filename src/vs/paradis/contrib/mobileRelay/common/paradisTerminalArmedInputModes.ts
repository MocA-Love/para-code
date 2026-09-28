/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

// 落ちた TUI エージェントが残した入力モードを、シェルに戻ったと確かめてから戻す。
//
// Claude Code / Codex は起動中に Kitty キーボードプロトコル・マウス報告・フォーカス報告などを
// 有効にし、終了時に戻す。異常終了（kill・クラッシュ）するとそれが残り、シェルで Shift+Enter や
// Ctrl 系が化け、フォーカスのたびに `^[[I` が出て、マウス（モバイルのスワイプを含む）が
// `ESC[<64;…M` としてシェルに届く。Orca の `terminal-armed-input-modes.ts` と同じく、コマンドの
// 開始（OSC 133;C）後に有効になったものだけを「コマンドのもの」として覚え、終了（133;D）の時点で
// まだ有効なものだけを戻す。コマンドの前から有効だったもの（シェル自身のもの）には触らない。
//
// Orca との違い: Orca は出力の流れを止めて 133;D の位置へリセットを差し込むが、ここでは出力の
// 流れに手を入れない。代わりに 133;D の後しばらく（プロンプトが描かれるまで）様子を見て、シェルが
// 入れ直したモードは外し、残りだけをその後ろへ書く（書き込みは xterm の受信待ちの末尾に並ぶ）。
//
// 対象外:
// - bracketed paste（?2004）と application cursor keys（?1）: bash・zsh・PowerShell がプロンプトで
//   自分で入れ直すので、戻すとシェルの設定を壊す（Orca も同じ理由で外している）
// - 代替画面（?1049 など）: 133;D の後ろに書くと、シェルが代替画面に描いたプロンプトごと主画面へ
//   戻って見えなくなる。代替画面に残っても入力は壊れないので戻さない

/** 戻す対象の DEC private モード。 */
const TRACKED_PRIVATE_MODES: ReadonlySet<number> = new Set([
	9, // X10 マウス
	1000, 1002, 1003, // マウス報告
	1004, // フォーカス報告
	1005, 1006, 1015, 1016, // マウス座標の形式
	66, // DECNKM（アプリケーションキーパッド）
]);
const MOUSE_REPORT_MODES: ReadonlySet<number> = new Set([9, 1000, 1002, 1003]);
const FOCUS_REPORT_MODE = 1004;
const APPLICATION_KEYPAD_MODE = 66;
/** 代替画面へ切り替えるモード。Kitty のフラグは画面ごとに別なので追う。 */
const ALTERNATE_SCREEN_MODES: ReadonlySet<number> = new Set([47, 1047, 1049]);

/** xterm が今どのモードにいるか（`Terminal.modes` の必要な分）。 */
export interface IParadisLiveInputModes {
	readonly mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
	readonly sendFocusMode: boolean;
	readonly applicationKeypadMode: boolean;
}

type Phase = 'idle' | 'command' | 'settling';

/**
 * コマンドが有効にした入力モードの台帳（xterm には触らない純粋なモデル）。
 *
 * 1. {@link commandStarted}（133;C）の後に有効になったモードを覚える
 * 2. {@link commandFinished}（133;D）の時点でまだ有効なものを「残り」とし、様子見に入る
 * 3. 様子見の間にシェルが入れ直した（または外した）モードは残りから外す
 * 4. {@link takeResetSequence} で、残りのうち xterm で実際に有効なものだけを戻す列を得る
 */
export class ParadisTerminalArmedInputModes {
	private phase: Phase = 'idle';
	private readonly armed = new Set<number>();
	/** コマンドが積んだ Kitty のフラグの数（画面ごと）。 */
	private kittyPushes = { main: 0, alternate: 0 };
	private onAlternateScreen = false;
	/** 様子見の間に Kitty のフラグが動いた（シェルが積んだ）。そのときは戻さない。 */
	private kittyTouchedWhileSettling = false;

	get isSettling(): boolean {
		return this.phase === 'settling';
	}

	/**
	 * OSC 133;C。ここから後に有効になったモードはコマンドのもの。
	 * 実行中にもう一度呼ばれた（ペインの識別が後から付いて開始を報告し直した）ときは、それまでに
	 * 覚えたモードを捨てない。
	 */
	commandStarted(): void {
		if (this.phase === 'command') {
			return;
		}
		this.phase = 'command';
		this.armed.clear();
		this.kittyPushes = { main: 0, alternate: 0 };
		this.kittyTouchedWhileSettling = false;
	}

	/**
	 * OSC 133;D。コマンドのモードが残っていれば様子見に入って true を返す。
	 * コマンドを見ていなかった（開始を取りこぼした）ときは何もしない。
	 */
	commandFinished(): boolean {
		if (this.phase !== 'command') {
			return false;
		}
		const left = this.armed.size > 0 || this.currentKittyPushes() > 0;
		this.phase = left ? 'settling' : 'idle';
		return left;
	}

	/** `CSI ? Pm h` / `CSI ? Pm l`。 */
	privateModes(params: readonly number[], enabled: boolean): void {
		for (const param of params) {
			if (ALTERNATE_SCREEN_MODES.has(param)) {
				this.onAlternateScreen = enabled;
				continue;
			}
			if (!TRACKED_PRIVATE_MODES.has(param)) {
				continue;
			}
			if (!enabled) {
				this.armed.delete(param);
			} else if (this.phase === 'command') {
				this.armed.add(param);
			} else if (this.phase === 'settling') {
				// シェルがプロンプトで入れ直した。以後はシェルのものなので戻さない。
				this.armed.delete(param);
			}
		}
	}

	/** `CSI > flags u`（Kitty のフラグを積む）。 */
	kittyPush(): void {
		if (this.phase === 'command') {
			this.addKittyPushes(1);
		} else if (this.phase === 'settling') {
			this.kittyTouchedWhileSettling = true;
		}
	}

	/** `CSI < n u`（Kitty のフラグを n 個降ろす）。 */
	kittyPop(count: number): void {
		if (this.phase === 'command') {
			this.addKittyPushes(-Math.max(1, count));
		} else if (this.phase === 'settling') {
			this.kittyTouchedWhileSettling = true;
		}
	}

	/** `ESC c`（RIS）。すべてのモードが切れる。 */
	fullReset(): void {
		this.armed.clear();
		this.kittyPushes = { main: 0, alternate: 0 };
		this.onAlternateScreen = false;
	}

	/**
	 * 様子見を終え、まだ残っているモードを戻す列を返す（戻すものが無ければ空文字）。
	 * マウス・フォーカス・キーパッドは、xterm で実際に有効なときだけ戻す。
	 */
	takeResetSequence(live: IParadisLiveInputModes): string {
		if (this.phase !== 'settling') {
			return '';
		}
		this.phase = 'idle';
		const modes = [...this.armed].filter(mode => {
			if (MOUSE_REPORT_MODES.has(mode)) {
				return live.mouseTrackingMode !== 'none';
			}
			if (mode === FOCUS_REPORT_MODE) {
				return live.sendFocusMode;
			}
			if (mode === APPLICATION_KEYPAD_MODE) {
				return live.applicationKeypadMode;
			}
			return true; // マウス座標の形式は xterm から読めない。残っていても無害な値へ戻すだけ
		}).sort((a, b) => a - b);
		const kittyPops = this.kittyTouchedWhileSettling ? 0 : this.currentKittyPushes();
		this.armed.clear();
		this.kittyPushes = { main: 0, alternate: 0 };
		let sequence = '';
		if (modes.length > 0) {
			sequence += `\x1b[?${modes.join(';')}l`;
		}
		if (kittyPops > 0) {
			sequence += `\x1b[<${kittyPops}u`;
		}
		return sequence;
	}

	/** 様子見をやめる（次のコマンドが始まった・ターミナルが閉じた）。 */
	cancel(): void {
		this.phase = 'idle';
		this.armed.clear();
		this.kittyPushes = { main: 0, alternate: 0 };
	}

	private currentKittyPushes(): number {
		return this.onAlternateScreen ? this.kittyPushes.alternate : this.kittyPushes.main;
	}

	private addKittyPushes(delta: number): void {
		if (this.onAlternateScreen) {
			this.kittyPushes.alternate = Math.max(0, this.kittyPushes.alternate + delta);
		} else {
			this.kittyPushes.main = Math.max(0, this.kittyPushes.main + delta);
		}
	}
}

/** xterm のうち、ここで使う分（テストで差し替える）。 */
export interface IParadisInputModeTerminal {
	readonly modes: IParadisLiveInputModes;
	readonly parser: {
		registerCsiHandler(id: { prefix?: string; final: string }, callback: (params: (number | number[])[]) => boolean): { dispose(): void };
		registerEscHandler(id: { final: string }, callback: () => boolean): { dispose(): void };
	};
	write(data: string, callback?: () => void): void;
}

/** 133;D の後、シェルがプロンプトを描き終えるのを待つ時間。 */
export const PARADIS_INPUT_MODE_SETTLE_MS = 300;

function flattenParams(params: (number | number[])[]): number[] {
	return params.map(param => Array.isArray(param) ? param[0] ?? 0 : param);
}

/**
 * 1つのターミナルに {@link ParadisTerminalArmedInputModes} を載せる。xterm のパーサーに
 * 「見るだけ」のフックを掛け（false を返して xterm 本来の処理へ流す）、133;D の後の様子見が
 * 終わったら、残ったモードを戻す列を xterm へ書く（PTY には送らない）。
 */
export class ParadisTerminalInputModeGuard {
	private readonly model = new ParadisTerminalArmedInputModes();
	private readonly hooks: { dispose(): void }[];
	private settleTimer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(
		private readonly terminal: IParadisInputModeTerminal,
		private readonly onReset?: (sequence: string) => void,
		private readonly settleMs: number = PARADIS_INPUT_MODE_SETTLE_MS,
	) {
		const parser = terminal.parser;
		this.hooks = [
			parser.registerCsiHandler({ prefix: '?', final: 'h' }, params => { this.model.privateModes(flattenParams(params), true); return false; }),
			parser.registerCsiHandler({ prefix: '?', final: 'l' }, params => { this.model.privateModes(flattenParams(params), false); return false; }),
			parser.registerCsiHandler({ prefix: '>', final: 'u' }, () => { this.model.kittyPush(); return false; }),
			parser.registerCsiHandler({ prefix: '<', final: 'u' }, params => { this.model.kittyPop(flattenParams(params)[0] ?? 1); return false; }),
			parser.registerEscHandler({ final: 'c' }, () => { this.model.fullReset(); return false; }),
		];
	}

	/** エージェントのコマンドが始まった（133;C）。 */
	commandStarted(): void {
		this.clearSettleTimer();
		this.model.commandStarted();
	}

	/** エージェントのコマンドが終わった（133;D）。シェルに戻ったので、様子を見てから残りを戻す。 */
	commandFinished(): void {
		if (!this.model.commandFinished()) {
			return;
		}
		this.clearSettleTimer();
		this.settleTimer = setTimeout(() => {
			this.settleTimer = undefined;
			// ここまでに受け取った出力（プロンプト）を xterm が読み終えてから判断する
			this.terminal.write('', () => this.flush());
		}, this.settleMs);
	}

	private flush(): void {
		if (this.disposed || !this.model.isSettling) {
			return;
		}
		const sequence = this.model.takeResetSequence(this.terminal.modes);
		if (sequence.length > 0) {
			this.terminal.write(sequence);
			this.onReset?.(sequence);
		}
	}

	private clearSettleTimer(): void {
		if (this.settleTimer !== undefined) {
			clearTimeout(this.settleTimer);
			this.settleTimer = undefined;
		}
	}

	dispose(): void {
		this.disposed = true;
		this.clearSettleTimer();
		this.model.cancel();
		for (const hook of this.hooks) {
			hook.dispose();
		}
	}
}
