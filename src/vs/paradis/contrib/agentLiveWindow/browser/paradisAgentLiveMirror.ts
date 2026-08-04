/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// allow-any-unicode-comment-file (Para Code: this file contains Japanese PARA-PATCH/PARA-CODE comments)

// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { $, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { timeout } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import { TERMINAL_BACKGROUND_COLOR } from '../../../../workbench/contrib/terminal/common/terminalColorRegistry.js';
import { IDetachedTerminalInstance, IDetachedXtermTerminal, ITerminalInstance, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { DetachedProcessInfo } from '../../../../workbench/contrib/terminal/browser/detachedTerminal.js';
import { XtermAddonImporter } from '../../../../workbench/contrib/terminal/browser/xterm/xtermAddonImporter.js';
import { PARADIS_TERMINAL_SHIFT_ENTER_SETTING } from '../../terminalShiftEnter/common/paradisTerminalShiftEnter.js';

interface ISerializeAddon {
	serialize(options?: { scrollback?: number }): string;
}

/**
 * xterm 内部の CoreService へ辿るための最小の形。`onUserInput` は ICoreService の公開
 * メンバーだが、そこへ至る `_core` は公開 API に出ていない (upstream の xtermTerminal.ts も
 * 同じ経路で _core を触っている)。
 */
interface IXtermWithUserInput {
	readonly _core?: {
		readonly coreService?: {
			readonly onUserInput?: (listener: () => void) => { dispose(): void };
		};
	};
}

/**
 * raw xterm ごとに serialize addon は1つだけ load する。ミラーを開き直すたびに load すると
 * 元の端末に addon が積み上がるため。
 *
 * これはライブウィンドウ内での重複を防ぐためのもので、モバイルリレー (自前の WeakMap を
 * インスタンスに持つ) とは別の台帳になる。同じ端末を両方が映すと SerializeAddon は端末あたり
 * 2つ load されるが、この addon の activate は端末参照を保持するだけでイベント購読等の
 * 副作用がないため実害はない。
 */
const serializeAddons = new WeakMap<object, ISerializeAddon>();

const SNAPSHOT_SCROLLBACK_ROWS = 200;
const WRITE_BARRIER_TIMEOUT = 1000;
const FALLBACK_COLS = 80;
/** これ以上小さくしても読めないので、はみ出させる方を選ぶ */
const MIN_FONT_SIZE = 5;
const FALLBACK_ROWS = 24;
/** 「下端に居る」とみなす許容差 (px)。端数で追従が切れないようにするための遊び。 */
const BOTTOM_PIN_TOLERANCE = 2;

/**
 * 1つのエージェント端末を、元の端末に触らずに別ウィンドウへ映す読み書き可能なミラー。
 *
 * xterm.js のインスタンスは1つの DOM にしか attach できないため、元の端末をここへ
 * 移送してしまうとメインウィンドウのタブから消える。そこで {@link ITerminalService.createDetachedTerminal}
 * で別の xterm を立て、
 *
 * - 出力: 元 instance の `onData` (pty からの生ストリーム) を write する
 * - 入力: ミラーへの打鍵を元 instance の `sendText` へ転送する
 *
 * という双方向の写しにしている。元の端末インスタンスは差し替えず、park や表示位置にも
 * 触らないので、メインウィンドウでの表示・操作はそのまま続けられる (同じ端末を2箇所から
 * 同時に使える)。ただし完全な無干渉ではなく、(1) スナップショットのために元 xterm へ
 * serialize addon を load する、(2) `sendText` は元の端末を最下部へスクロールさせる、
 * という副作用は残る。
 *
 * 列数は元の端末に合わせる。エージェントCLIのTUIは pty に通知された列数で折り返し済みの
 * 出力を吐くため、ミラー側で別の列数にすると表示が崩れる。タイル幅への収まりは
 * CSS の縮小 (--paradis-agent-live-scale) で吸収する。
 */
export class ParadisAgentLiveMirror extends Disposable {

	private readonly addonImporter = new XtermAddonImporter();
	private readonly mount: HTMLElement;
	private readonly streamListener = this._register(new MutableDisposable());
	private readonly resizeListener = this._register(new MutableDisposable());

	private readonly resizeObserverCtor: typeof ResizeObserver | undefined;
	private detached: IDetachedTerminalInstance | undefined;
	private raw: RawXtermTerminal | undefined;
	/** 縮小前の文字サイズ。ウィンドウを広げたときにここまで戻す */
	private baseFontSize = 0;
	/** 指定された文字サイズ。undefined ならタイル幅に合わせて自動で縮める */
	private fixedFontSize: number | undefined;
	private resizeObserver: ResizeObserver | undefined;
	/** スナップショットを流し込むまでに届いた出力の待避先 */
	private pending: string[] = [];
	private streaming = false;
	private visible = true;
	private syncing = false;
	/** 同期中に届いた再同期要求。取りこぼすとその端末が更新されないまま固まる */
	private pendingResync = false;
	/** 直前のデータがユーザー由来か (xterm の onUserInput が立てる印。自動応答と区別する) */
	private forwardUserInput = false;
	/** ユーザー入力の判別ができなかった場合、逆流を避けるため転送そのものを止める */
	private inputForwardingDisabled = false;
	/**
	 * 端末領域を最新行 (下端) へ寄せ続けるか。ミラーはタイルより大きいことが多く、切れた上部を
	 * 読むためにタイル側をスクロールできるようにしてある。ユーザーが自分で上へ動かしている間は
	 * 追従を止め、下端へ戻したら再開する (再同期やリサイズのたびに引き戻さない)。
	 */
	private pinnedToBottom = true;
	private disposed = false;

	constructor(
		private readonly instance: ITerminalInstance,
		private readonly container: HTMLElement,
		/** テストから差し替えるための注入点。undefined ならタイルが載っているウィンドウのものを使う。 */
		resizeObserverCtor: typeof ResizeObserver | undefined,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.resizeObserverCtor = resizeObserverCtor ?? container.ownerDocument.defaultView?.ResizeObserver;
		this.mount = $('.paradis-agent-live-term-mount');
		this.container.appendChild(this.mount);
		this._register(addDisposableListener(this.container, EventType.SCROLL, () => this.updateBottomPin()));
		this._register({
			dispose: () => {
				this.resizeObserver?.disconnect();
				this.resizeObserver = undefined;
				this.mount.remove();
			}
		});
	}

	async start(): Promise<void> {
		if (this.disposed || this.detached) {
			return;
		}

		const processInfo = this._register(new DetachedProcessInfo({ initialCwd: '' }));
		const detached = await this.terminalService.createDetachedTerminal({
			cols: this.instance.cols > 0 ? this.instance.cols : FALLBACK_COLS,
			rows: this.instance.rows > 0 ? this.instance.rows : FALLBACK_ROWS,
			readonly: false,
			processInfo,
			disableOverviewRuler: true,
			colorProvider: { getBackgroundColor: (theme: IColorTheme) => theme.getColor(TERMINAL_BACKGROUND_COLOR) },
		});
		if (this.disposed) {
			detached.dispose();
			return;
		}
		this.detached = this._register(detached);
		detached.attachToElement(this.mount, { enableGpu: false });
		this.raw = (detached.xterm as IDetachedXtermTerminal & { raw: RawXtermTerminal }).raw;
		this.baseFontSize = this.raw.options.fontSize ?? 12;

		this.installUserInputGate(detached);
		if (!this.inputForwardingDisabled) {
			this._register(detached.onData(data => this.onMirrorData(data)));
		}

		// 元の列数が変わったら追随する。列数が違うと折り返しがずれるため、合わせた上で
		// 画面を取り直す。
		this.resizeListener.value = this.instance.onDimensionsChanged(() => {
			if (!this.detached) {
				return;
			}
			this.detached.xterm.resize(
				this.instance.cols > 0 ? this.instance.cols : FALLBACK_COLS,
				this.instance.rows > 0 ? this.instance.rows : FALLBACK_ROWS,
			);
			this.resync().catch(onUnexpectedError);
		});

		this.observeResize();
		// ResizeObserver の初回通知や resync 頼みにしない。観測できない環境でも、指定された
		// 文字サイズは最初の描画から効いていてほしい。
		this.updateFontSize();
		this.pinToBottom();
		await this.resync();
	}

	/**
	 * 画面外に出たタイルは出力の購読を止める。復帰時にスナップショットを取り直すので、
	 * 止めていた間の出力で表示が欠けることはない。
	 */
	setVisible(visible: boolean): void {
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		if (!visible) {
			this.streamListener.clear();
			this.streaming = false;
			this.pending = [];
			return;
		}
		this.resync().catch(onUnexpectedError);
	}

	/** 入力の転送ができない状態か (タイル側で読み取り専用と表示するため)。 */
	get isReadonly(): boolean {
		return this.inputForwardingDisabled;
	}

	layout(): void {
		this.updateFontSize();
		this.pinToBottom();
	}

	/**
	 * 文字サイズを指定する。undefined を渡すとタイル幅に全体を収める従来動作へ戻る。
	 * 指定した場合、タイルからはみ出す右端と上部はタイルの外に出る (タイル自身がスクロール
	 * 可能なので、そこまで辿ることはできる)。
	 */
	setFontSize(size: number | undefined): void {
		if (this.fixedFontSize === size) {
			return;
		}
		this.fixedFontSize = size;
		this.updateFontSize();
		this.pinToBottom();
	}

	/**
	 * いまタイルに見えているセル数。指定した文字サイズだと元の端末のどこまでが見えるのかを
	 * 設定画面で示すために使う。まだ描画されていなければ undefined。
	 */
	getVisibleCells(): { readonly cols: number; readonly rows: number; readonly totalCols: number; readonly totalRows: number } | undefined {
		const raw = this.raw;
		const width = this.mount.offsetWidth;
		const height = this.mount.offsetHeight;
		if (!raw || raw.cols <= 0 || raw.rows <= 0 || width <= 0 || height <= 0) {
			return undefined;
		}
		const cellWidth = width / raw.cols;
		const cellHeight = height / raw.rows;
		return {
			cols: Math.max(0, Math.min(raw.cols, Math.floor(this.container.clientWidth / cellWidth))),
			rows: Math.max(0, Math.min(raw.rows, Math.floor(this.container.clientHeight / cellHeight))),
			totalCols: raw.cols,
			totalRows: raw.rows,
		};
	}

	/**
	 * ミラーの xterm が出すデータのうち、ユーザーの入力だけを元の端末へ転送する。
	 *
	 * xterm の `onData` は打鍵だけでなく、端末が問い合わせに自動で返す応答 (DA / DSR-CPR /
	 * XTVERSION など) も同じ経路で流す。エージェントCLIのTUIはこの手の問い合わせを起動時や
	 * 再描画のたびに吐くため、素通しにするとミラーの応答が「ユーザーが打った文字」として
	 * pty へ注入され、本物の端末が返す応答と二重になってプロンプトが壊れる。
	 *
	 * xterm 内部の `coreService.onUserInput` は `triggerDataEvent(data, wasUserInput)` が
	 * ユーザー由来のときだけ、同じ呼び出しの中で `onData` の直前に発火する。打鍵・貼り付け・
	 * IME確定・マウスレポートにはこの印が付き、自動応答には付かない。DOM イベントを
	 * 自前で捕まえる方式では、貼り付け (bubble リスナ) や IME (setTimeout 経由) を取りこぼす。
	 *
	 * なお `triggerBinaryEvent` (バイナリ系のマウスレポート) は `onData` を通らないので
	 * 転送されない。Windows の win32 input mode で修飾キー単独の押下/解放も届かない。
	 */
	private installUserInputGate(detached: IDetachedTerminalInstance): void {
		// attachToElement より後に呼ぶこと。xterm 自身のリスナ (SelectionService など) が
		// 先に onUserInput へ登録されている状態でないと、印を立てる順序が入れ替わって
		// 「自動応答を転送し、打鍵を捨てる」逆転が起きうる。
		const raw = this.raw ?? (detached.xterm as IDetachedXtermTerminal & { raw: RawXtermTerminal }).raw;
		const onUserInput = (raw as unknown as IXtermWithUserInput)._core?.coreService?.onUserInput;
		if (!onUserInput) {
			// 印が取れないと自動応答と打鍵を区別できない。逆流させるくらいなら読み取り専用にする。
			this.inputForwardingDisabled = true;
			onUnexpectedError(new Error('[paradisAgentLiveWindow] xterm coreService.onUserInput is unavailable; mirror input is disabled'));
			return;
		}
		this._register(onUserInput(() => { this.forwardUserInput = true; }));

		raw.attachCustomKeyEventHandler(event => {
			// ミラーには terminalFocus コンテキストが付かず、本体側の Shift+Enter キーバインドが
			// 届かない。同じ ESC+CR を自前で送って挙動を揃える (pwsh + シェル統合時に本体が
			// 使う PSReadLine 向けの別シーケンスまでは再現しない)。
			if (event.type === 'keydown' && this.isShiftEnterNewline(event)) {
				// false を返しても xterm は preventDefault しないため、明示的に止める。
				// そうしないとブラウザ既定の改行がヘルパ textarea に溜まり続ける。
				event.preventDefault();
				this.instance.sendText('\x1b\r', false).catch(onUnexpectedError);
				return false;
			}
			return true;
		});
	}

	private isShiftEnterNewline(event: KeyboardEvent): boolean {
		return event.key === 'Enter'
			&& event.shiftKey
			&& !event.ctrlKey
			&& !event.altKey
			&& !event.metaKey
			&& this.configurationService.getValue(PARADIS_TERMINAL_SHIFT_ENTER_SETTING) === true;
	}

	private onMirrorData(data: string): void {
		// onUserInput が直前に立てた印が無いデータ = 端末の自動応答。捨てる。
		if (!this.forwardUserInput) {
			return;
		}
		this.forwardUserInput = false;
		this.instance.sendText(data, false).catch(onUnexpectedError);
	}

	/**
	 * 元の端末の現画面をスナップショットとして流し込み、以降のストリームへ繋ぐ。
	 * 同期中に届いた要求は取りこぼさずに引き継ぐ (取りこぼすと、購読が外れたまま
	 * 更新されないタイルが残る)。
	 */
	private async resync(): Promise<void> {
		if (this.syncing) {
			this.pendingResync = true;
			return;
		}
		this.syncing = true;
		try {
			do {
				this.pendingResync = false;
				await this.syncOnce();
			} while (this.pendingResync && !this.disposed);
		} catch (error) {
			// 失敗したまま放置すると、書き出されない出力が pending に溜まり続ける。画面は
			// 崩れたままだが、以降の出力は流し続ける (次に可視状態が変わるか元の端末が
			// リサイズされた時点で取り直される)。
			this.pending = [];
			this.streaming = true;
			onUnexpectedError(error);
		} finally {
			this.syncing = false;
		}
	}

	/**
	 * 購読を先に始めて出力を待避しておき、xterm の書き込みバリアが返ってから
	 * シリアライズする。こうしないと「スナップショットにもストリームにも含まれない」
	 * 欠落窓ができる (モバイルリレーの同期と同じ理由)。
	 */
	private async syncOnce(): Promise<void> {
		const detached = this.detached;
		if (!detached || this.disposed || !this.visible) {
			return;
		}
		this.streaming = false;
		this.pending = [];
		this.streamListener.value = this.instance.onData(data => this.onSourceData(data));

		const snapshot = await this.serializeSource();
		if (this.disposed || !this.visible || this.detached !== detached) {
			return;
		}
		detached.xterm.reset();
		if (snapshot) {
			detached.xterm.write(snapshot);
		}
		// バリアより前の出力はスナップショットに含まれている。バリア後に届いた分だけを流す。
		const pending = this.pending;
		this.pending = [];
		this.streaming = true;
		for (const data of pending) {
			detached.xterm.write(data);
		}
		this.updateFontSize();
		this.pinToBottom();
	}

	private onSourceData(data: string): void {
		if (this.streaming) {
			this.detached?.xterm.write(data);
		} else {
			this.pending.push(data);
		}
	}

	private async serializeSource(): Promise<string | undefined> {
		// park 中でまだ xterm が構築されていない端末もある。待てば現れる。
		const xterm = this.instance.xterm ?? await this.instance.xtermReadyPromise;
		if (!xterm || this.disposed) {
			return undefined;
		}
		const raw = xterm.raw;
		let addon = serializeAddons.get(raw);
		if (!addon) {
			const Ctor = await this.addonImporter.importAddon('serialize');
			if (this.disposed) {
				return undefined;
			}
			const loaded = new Ctor();
			raw.loadAddon(loaded);
			addon = loaded;
			serializeAddons.set(raw, loaded);
		}
		// 端末が dispose された等でコールバックが来ない場合に備えて上限付きで待つ。
		const barrierPassed = await Promise.race([
			new Promise<boolean>(resolve => raw.write('', () => resolve(true))),
			timeout(WRITE_BARRIER_TIMEOUT).then(() => false),
		]);
		if (this.disposed) {
			return undefined;
		}
		if (barrierPassed) {
			// バリアを跨いだ時点までが確実にスナップショットへ入る。ここから後の出力は pending 側。
			this.pending = [];
		}
		// タイムアウトした場合は「どこまでが snapshot に入ったか」が保証されないので待避分を
		// 捨てない。二重に書かれる方が、欠けたまま残るよりましなため。
		return addon.serialize({ scrollback: SNAPSHOT_SCROLLBACK_ROWS });
	}

	/** いま下端に居るかを記録する ({@link BOTTOM_PIN_TOLERANCE} までのずれは端数として下端扱い)。 */
	private updateBottomPin(): void {
		const distance = this.container.scrollHeight - this.container.clientHeight - this.container.scrollTop;
		this.pinnedToBottom = distance <= BOTTOM_PIN_TOLERANCE;
	}

	/**
	 * 最新行が見えるところまで寄せ直す。ミラーの高さが変わる操作 (再同期・リサイズ・文字サイズの
	 * 変更) のあとに呼ぶ。追従を切っている (上を読んでいる) 間は動かさない。
	 */
	private pinToBottom(): void {
		if (this.pinnedToBottom) {
			this.container.scrollTop = this.container.scrollHeight;
		}
	}

	private observeResize(): void {
		if (!this.resizeObserverCtor) {
			return;
		}
		// タイル (container) だけでなくミラー本体 (mount) も観測する。文字サイズや行数が変わると
		// 高さが変わるのは mount 側で、それを見ていないと最新行への寄せ直しが効かない
		// (初回描画で 0 から一気に伸びる場合も含む)。文字サイズの計算し直しはタイル側の変化に
		// 限る —— mount の変化で回すと、寸法を変える処理が自分の通知で再入する。
		// 「mount だけが変わる」ケース (元の端末の桁数変更) の計算し直しは onDimensionsChanged →
		// resync → syncOnce 末尾の updateFontSize が担っている。resync 経路を変えるときは注意。
		this.resizeObserver = new this.resizeObserverCtor(entries => {
			if (entries.some(entry => entry.target === this.container)) {
				this.updateFontSize();
			}
			this.pinToBottom();
		});
		this.resizeObserver.observe(this.container);
		this.resizeObserver.observe(this.mount);
	}

	/**
	 * 文字サイズを反映する。{@link setFontSize} で指定があればその大きさで描き、無ければ
	 * タイル幅に収まるよう詰める (元の端末の桁数はこちらでは決められないので、桁数はそのまま
	 * に文字を小さくして全体を見せる)。
	 *
	 * 自動で詰める側には下限がある。本体が 4K・このウィンドウが FHD といった組み合わせでは
	 * 必要な縮小率が 1/4 を超え、全体を入れようとすると判読できない大きさになるため。
	 *
	 * 桁数を揃えれば見た目は揃うが、外から端末をリサイズするのは見送っている。`layout()` は
	 * 渡した寸法を記憶して後から再生するため、メインでその端末を開いた瞬間にタイルの大きさで
	 * 復元されてしまう。専用の設定口を足しても、(1) 桁数は pty へ伝わりスクロールバックが
	 * その幅で折り返し直される、(2) park の出入りを取りこぼさず検出できない (エディタ側の
	 * park は可視性イベントを出さない)、(3) 戻す値と upstream が測り直した値の取り合いになる、
	 * という問題が残る。実端末を壊す危険の方が、見た目が揃う利得より大きい。
	 *
	 * CSS の `transform: scale()` で縮めてもいけない。xterm のマウス座標計算 (Mouse.ts の
	 * getCoords) は「transform 後の実測矩形」を「transform 前のセル幅」で割るため、縮小した分
	 * だけ列と行がずれる。ドラッグ選択が別のセルを掴むだけでなく、TUI がマウストラッキングを
	 * 有効にしていると、ずれた座標のマウスレポートがそのまま本物の pty へ送られてしまう。
	 * 文字サイズを変える方法ならセル寸法自体が再計算されるので座標は常に一致する。
	 */
	private updateFontSize(): void {
		const raw = this.raw;
		if (!raw) {
			return;
		}
		const fixed = this.fixedFontSize;
		if (fixed !== undefined) {
			// 指定された大きさで描く。タイルに収まるかどうかは見ない —— 収めようとすると
			// 桁数の多い端末では判読できない大きさになるため、はみ出させる方を選ぶ
			// (mount は左寄せ・下端揃えなので、まず最新行と行頭が見える。はみ出した右端と
			// 上部はタイルをスクロールすれば読める)。
			if (raw.options.fontSize !== fixed) {
				raw.options.fontSize = fixed;
			}
			return;
		}
		const available = this.container.clientWidth;
		const width = this.mount.offsetWidth;
		if (available <= 0 || width <= 0) {
			return;
		}
		const current = raw.options.fontSize ?? this.baseFontSize;
		if (current <= 0) {
			return;
		}
		// 0.5px 刻みに丸め、元のサイズを超えては拡大しない (拡大してもぼやけるだけ)。
		const target = Math.floor(current * (available / width) * 2) / 2;
		const next = Math.max(MIN_FONT_SIZE, Math.min(this.baseFontSize, target));
		if (Math.abs(next - current) >= 0.5) {
			raw.options.fontSize = next;
		}
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}
