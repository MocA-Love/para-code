// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

export interface VoiceLifecycleTimers {
	setTimeout(handler: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export const VOICE_RESUBSCRIBE_MS = 20_000;
export const VOICE_RETRY_MS = 3_000;

export interface VoiceNotificationState {
	readonly desired: boolean;
	readonly status: 'idle' | 'connecting' | 'live' | 'reconnecting' | 'unsupported' | 'error';
	readonly error?: string;
}

export interface VoiceLifecycleSnapshot {
	readonly nativeSupported: boolean;
	readonly protocolUnsupported: boolean;
	readonly connectionReady: boolean;
}

/** appState とネイティブbridge/relayの境界。テストではここだけを差し替える。 */
export interface MobileVoiceLifecycleHost {
	getSnapshot(): VoiceLifecycleSnapshot;
	setState(state: VoiceNotificationState): void;
	createSessionId(): string;
	activate(): Promise<void>;
	deactivate(): Promise<void>;
	subscribe(sid: string): Promise<void>;
	unsubscribe(sid: string): void;
	setClipHandler(sid: string, handler: (base64: string) => void): void;
	clearClipHandler(sid: string): void;
	onRemoteStop(handler: () => void): () => void;
	enqueueClip(base64: string): Promise<void>;
	afterStop(): void;
}

/** 音声受信の非同期処理を、開始時の世代へ結び付ける。 */
export class VoiceLifecycle {
	private generation = 0;
	private timer: unknown;
	private disposed = false;

	constructor(private readonly timers: VoiceLifecycleTimers = globalThis) { }

	get currentGeneration(): number {
		return this.generation;
	}

	start(): number {
		if (this.disposed) {
			throw new Error('voice lifecycle is disposed');
		}
		this.clearScheduled();
		return ++this.generation;
	}

	isCurrent(generation: number): boolean {
		return !this.disposed && generation === this.generation;
	}

	runIfCurrent(generation: number, callback: () => void): boolean {
		if (!this.isCurrent(generation)) {
			return false;
		}
		callback();
		return true;
	}

	schedule(generation: number, delayMs: number, callback: () => void): void {
		if (!this.isCurrent(generation)) {
			return;
		}
		this.clearScheduled();
		let handle: unknown;
		handle = this.timers.setTimeout(() => {
			// clearTimeout の直前にキューへ移った古い callback が後着しても、
			// 新しい世代の timer の所有権を奪わない。
			if (this.timer === handle) {
				this.timer = undefined;
			}
			this.runIfCurrent(generation, callback);
		}, delayMs);
		this.timer = handle;
	}

	clearScheduled(): void {
		if (this.timer !== undefined) {
			this.timers.clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	stop(): void {
		this.generation++;
		this.clearScheduled();
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.generation++;
		this.clearScheduled();
	}
}

/**
 * Mobile音声通知の開始・relay購読・再購読・停止を一つの世代で管理する。
 * appState は状態遷移やtimerを個別に持たず、このorchestratorへbridgeを渡すだけにする。
 */
export class MobileVoiceLifecycle {
	private readonly lifecycle: VoiceLifecycle;
	private sessionId: string | undefined;
	private desired = false;
	private disposed = false;
	private remoteStopSubscription: (() => void) | undefined;

	constructor(
		private readonly host: MobileVoiceLifecycleHost,
		timers: VoiceLifecycleTimers = globalThis,
	) {
		this.lifecycle = new VoiceLifecycle(timers);
	}

	start(): void {
		if (this.disposed || this.desired) {
			return;
		}
		const snapshot = this.host.getSnapshot();
		if (!snapshot.nativeSupported) {
			this.host.setState({ desired: false, status: 'unsupported', error: 'このビルドでは音声通知を利用できません' });
			return;
		}
		if (snapshot.protocolUnsupported) {
			this.host.setState({ desired: false, status: 'unsupported', error: 'PC版のPara Codeを音声通知対応版へ更新してください' });
			return;
		}

		const generation = this.lifecycle.start();
		const sid = this.host.createSessionId();
		this.sessionId = sid;
		this.desired = true;
		this.host.setState({ desired: true, status: 'connecting' });
		void this.begin(generation, sid);
	}

	stop(): void {
		if (this.disposed) {
			return;
		}
		this.lifecycle.stop();
		this.finishStop();
	}

	/** relay復帰時に、現在の世代の購読だけを即座に送り直す。 */
	reconnect(): void {
		const sid = this.sessionId;
		if (!this.desired || sid === undefined) {
			return;
		}
		this.lifecycle.clearScheduled();
		void this.connect(this.lifecycle.currentGeneration, sid);
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.lifecycle.dispose();
		this.finishStop();
	}

	private async begin(generation: number, sid: string): Promise<void> {
		try {
			await this.host.activate();
			if (!this.isCurrent(generation, sid)) {
				return;
			}
			this.remoteStopSubscription?.();
			this.remoteStopSubscription = this.host.onRemoteStop(() => {
				this.lifecycle.runIfCurrent(generation, () => this.stop());
			});
			this.host.setClipHandler(sid, base64 => {
				this.lifecycle.runIfCurrent(generation, () => {
					void this.host.enqueueClip(base64).catch(() => { /* 再生できないクリップは捨てる */ });
				});
			});
			await this.connect(generation, sid);
		} catch (error) {
			if (!this.isCurrent(generation, sid)) {
				return;
			}
			this.lifecycle.stop();
			this.desired = false;
			this.sessionId = undefined;
			this.host.clearClipHandler(sid);
			this.remoteStopSubscription?.();
			this.remoteStopSubscription = undefined;
			const message = error instanceof Error ? error.message : '音声通知を開始できませんでした';
			this.host.setState({ desired: false, status: 'error', error: message });
			await this.host.deactivate().catch(() => { /* 停止の失敗は表示済みのエラーへ足さない */ });
		}
	}

	private async connect(generation: number, sid: string): Promise<void> {
		if (!this.isCurrent(generation, sid)) {
			return;
		}
		const snapshot = this.host.getSnapshot();
		if (snapshot.protocolUnsupported) {
			this.stop();
			this.host.setState({ desired: false, status: 'unsupported', error: 'PC版のPara Codeを音声通知対応版へ更新してください' });
			return;
		}
		if (!snapshot.connectionReady) {
			this.scheduleReconnect(generation, sid, 'PCへの接続を待っています');
			return;
		}
		try {
			await this.host.subscribe(sid);
			if (!this.isCurrent(generation, sid)) {
				return;
			}
			this.host.setState({ desired: true, status: 'live' });
			this.lifecycle.schedule(generation, VOICE_RESUBSCRIBE_MS, () => {
				void this.connect(generation, sid);
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : '音声接続に失敗しました';
			this.scheduleReconnect(generation, sid, message);
		}
	}

	private scheduleReconnect(generation: number, sid: string, message: string): void {
		if (!this.isCurrent(generation, sid)) {
			return;
		}
		this.host.setState({ desired: true, status: 'reconnecting', error: message });
		this.lifecycle.schedule(generation, VOICE_RETRY_MS, () => {
			void this.connect(generation, sid);
		});
	}

	private isCurrent(generation: number, sid: string): boolean {
		return this.desired && this.sessionId === sid && this.lifecycle.isCurrent(generation);
	}

	private finishStop(): void {
		this.desired = false;
		const sid = this.sessionId;
		this.sessionId = undefined;
		if (sid !== undefined) {
			this.host.clearClipHandler(sid);
			this.host.unsubscribe(sid);
		}
		this.remoteStopSubscription?.();
		this.remoteStopSubscription = undefined;
		this.host.setState({ desired: false, status: 'idle' });
		void this.host.deactivate().catch(() => { /* 停止できなくても操作は完了扱い */ });
		this.host.afterStop();
	}
}
