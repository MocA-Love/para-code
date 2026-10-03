// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

/**
 * 「システム」画面の時系列グラフの値（PC 側 `paradisSystemUsage.ts` の `IParadisSystemUsageResponse` と同じ形）。
 *
 * PC（手元は shared process、SSH の接続先は REH）が 5 秒刻み 720 点と 1 分刻み 1440 点を持ち続ける。アプリは
 * 開いたときに全点を取り、以後は `since` と `instanceId` を付けて差分だけを取り、手元の写しへ足す。
 *
 * PC 側のファイルはアプリの型検査（`noUncheckedIndexedAccess`）を通らない書き方をしているので import せず、
 * ここに同じ形を書く。形を変えるときは両方を直す。
 */

/** `sysres` の `history` を受けられる PC の印。 */
export const SYSTEM_HISTORY_CAPABILITY = 'system.history.v1';
export const SYSTEM_USAGE_VERSION = 1;

export type SystemUsageTier = 'fine' | 'coarse';
export type SystemUsageRange = '5m' | '1h' | '24h';
export type SystemUsageMetric = 'cpu' | 'memory' | 'disk' | 'diskIo' | 'network' | 'swap';

export const SYSTEM_USAGE_FINE_CAPACITY = 720;
export const SYSTEM_USAGE_COARSE_CAPACITY = 1440;

export interface SystemUsageSample {
	readonly t: number;
	readonly cpu?: number;
	readonly mem?: number;
	readonly disk?: number;
	readonly diskRead?: number;
	readonly diskWrite?: number;
	readonly netRx?: number;
	readonly netTx?: number;
	readonly swapUsed?: number;
}

export type SystemUsageField = Exclude<keyof SystemUsageSample, 't'>;
export const SYSTEM_USAGE_FIELDS: readonly SystemUsageField[] = ['cpu', 'mem', 'disk', 'diskRead', 'diskWrite', 'netRx', 'netTx', 'swapUsed'];

export interface SystemUsageMachine {
	readonly os: string;
	readonly hostname: string;
	readonly cores: number;
	readonly memTotal: number;
	readonly diskPath?: string;
	readonly diskTotal?: number;
	readonly swapTotal?: number;
}

/** PC へ送る `history`。 */
export interface SystemUsageHistoryRequest {
	/**
	 * どのマシンの値か（`local` はこの PC、`remote` は送り先のウィンドウの SSH の接続先）。PC は名指しどおりに答える
	 * （SSH のウィンドウにしか届かなくても、`local` ならこの PC の値を返す）。
	 */
	readonly machine: 'local' | 'remote';
	readonly tier: SystemUsageTier;
	readonly since?: number;
	readonly instanceId?: string;
	readonly maxPoints?: number;
}

/** PC から届く `history`（列ごとの形）。相手は信用せず {@link parseSystemUsageResponse} で読む。 */
export interface SystemUsageResponseWire {
	readonly version?: unknown;
	readonly instanceId?: unknown;
	readonly machine?: unknown;
	readonly tier?: unknown;
	readonly stepMs?: unknown;
	readonly reset?: unknown;
	readonly unsupported?: unknown;
	readonly series?: unknown;
	readonly latest?: unknown;
}

export interface SystemUsageResponse {
	readonly instanceId: string;
	readonly machine: SystemUsageMachine | undefined;
	readonly tier: SystemUsageTier;
	readonly stepMs: number;
	readonly reset: boolean;
	readonly unsupported: readonly SystemUsageMetric[];
	readonly samples: SystemUsageSample[];
	readonly latest: SystemUsageSample | undefined;
}

/** 手元の写し（マシン×段ごとに1つ）。 */
export interface SystemUsageCopy {
	readonly instanceId: string | undefined;
	readonly samples: readonly SystemUsageSample[];
	readonly machine: SystemUsageMachine | undefined;
	readonly unsupported: readonly SystemUsageMetric[];
	readonly latest: SystemUsageSample | undefined;
}

export const EMPTY_SYSTEM_USAGE_COPY: SystemUsageCopy = { instanceId: undefined, samples: [], machine: undefined, unsupported: [], latest: undefined };

export function rangeSpec(range: SystemUsageRange): { readonly tier: SystemUsageTier; readonly windowMs: number; readonly stepMs: number } {
	switch (range) {
		case '5m': return { tier: 'fine', windowMs: 5 * 60_000, stepMs: 5_000 };
		case '1h': return { tier: 'fine', windowMs: 60 * 60_000, stepMs: 5_000 };
		case '24h': return { tier: 'coarse', windowMs: 24 * 60 * 60_000, stepMs: 60_000 };
	}
}

export function tierCapacity(tier: SystemUsageTier): number {
	return tier === 'fine' ? SYSTEM_USAGE_FINE_CAPACITY : SYSTEM_USAGE_COARSE_CAPACITY;
}

/** 写しから次の要求を作る（初回は全点、以後は差分）。24 時間は 720 点に間引いて受け取る。 */
export function historyRequestFor(copy: SystemUsageCopy, tier: SystemUsageTier, machine: 'local' | 'remote'): SystemUsageHistoryRequest {
	const last = copy.samples[copy.samples.length - 1];
	return {
		machine,
		tier,
		...(last !== undefined && copy.instanceId !== undefined ? { since: last.t, instanceId: copy.instanceId } : {}),
		...(tier === 'coarse' ? { maxPoints: 720 } : {}),
	};
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

type MutableSample = { -readonly [K in keyof SystemUsageSample]: SystemUsageSample[K] };

export function parseSystemUsageSample(value: unknown): SystemUsageSample | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const t = finiteNumber(record['t']);
	if (t === undefined) {
		return undefined;
	}
	const sample: MutableSample = { t };
	for (const field of SYSTEM_USAGE_FIELDS) {
		const fieldValue = finiteNumber(record[field]);
		if (fieldValue !== undefined) {
			sample[field] = fieldValue;
		}
	}
	return sample;
}

/** 列ごとの形を点の並びへ（時刻が数でない点は落とす）。 */
export function decodeSystemUsageSeries(series: unknown): SystemUsageSample[] {
	if (typeof series !== 'object' || series === null) {
		return [];
	}
	const record = series as Record<string, unknown>;
	const times = Array.isArray(record['t']) ? record['t'] as unknown[] : [];
	const columns = SYSTEM_USAGE_FIELDS.map(field => {
		const column = record[field];
		return [field, Array.isArray(column) ? column as unknown[] : []] as const;
	});
	const result: SystemUsageSample[] = [];
	times.forEach((rawT, index) => {
		const t = finiteNumber(rawT);
		if (t === undefined) {
			return;
		}
		const sample: MutableSample = { t };
		for (const [field, column] of columns) {
			const value = finiteNumber(column[index]);
			if (value !== undefined) {
				sample[field] = value;
			}
		}
		result.push(sample);
	});
	return result;
}

const METRICS: readonly SystemUsageMetric[] = ['cpu', 'memory', 'disk', 'diskIo', 'network', 'swap'];

function parseMachine(value: unknown): SystemUsageMachine | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const optional = (key: 'diskTotal' | 'swapTotal') => {
		const n = finiteNumber(record[key]);
		return n !== undefined ? { [key]: n } : {};
	};
	return {
		os: typeof record['os'] === 'string' ? record['os'] : '',
		hostname: typeof record['hostname'] === 'string' ? record['hostname'] : '',
		cores: finiteNumber(record['cores']) ?? 0,
		memTotal: finiteNumber(record['memTotal']) ?? 0,
		...(typeof record['diskPath'] === 'string' ? { diskPath: record['diskPath'] } : {}),
		...optional('diskTotal'),
		...optional('swapTotal'),
	};
}

/** PC の `history` を読む。版が違う・形が崩れている（instanceId が無い）なら undefined。 */
export function parseSystemUsageResponse(wire: unknown): SystemUsageResponse | undefined {
	if (typeof wire !== 'object' || wire === null) {
		return undefined;
	}
	const record = wire as SystemUsageResponseWire;
	if (record.version !== SYSTEM_USAGE_VERSION || typeof record.instanceId !== 'string' || record.instanceId.length === 0) {
		return undefined;
	}
	const tier: SystemUsageTier = record.tier === 'coarse' ? 'coarse' : 'fine';
	return {
		instanceId: record.instanceId,
		machine: parseMachine(record.machine),
		tier,
		stepMs: finiteNumber(record.stepMs) ?? (tier === 'fine' ? 5_000 : 60_000),
		reset: record.reset !== false,
		unsupported: Array.isArray(record.unsupported) ? METRICS.filter(metric => (record.unsupported as unknown[]).includes(metric)) : [],
		samples: decodeSystemUsageSeries(record.series),
		latest: parseSystemUsageSample(record.latest),
	};
}

/**
 * 届いた応答を写しへ足す。`reset` か測る側が変わった（instanceId が違う）なら置き換える。
 * 既にある点以前の時刻は捨て、`capacity` を超えた古い点を落とす。
 */
export function mergeSystemUsage(copy: SystemUsageCopy, response: SystemUsageResponse): SystemUsageCopy {
	const replace = response.reset || response.instanceId !== copy.instanceId;
	const samples = replace ? [] : [...copy.samples];
	let lastT = samples[samples.length - 1]?.t ?? -Infinity;
	for (const sample of response.samples) {
		if (sample.t > lastT) {
			samples.push(sample);
			lastT = sample.t;
		}
	}
	const capacity = tierCapacity(response.tier);
	const trimmed = samples.length > capacity ? samples.slice(samples.length - capacity) : samples;
	return {
		instanceId: response.instanceId,
		samples: trimmed,
		machine: response.machine ?? copy.machine,
		unsupported: response.unsupported,
		latest: response.latest ?? trimmed[trimmed.length - 1],
	};
}

/** 時間の幅に入る点。右端は最新の点の時刻（PC と端末の時計のずれで線が寄りきらないのを避ける）。 */
export function systemUsageWindow(samples: readonly SystemUsageSample[], windowMs: number): { readonly samples: readonly SystemUsageSample[]; readonly start: number; readonly end: number } {
	const last = samples[samples.length - 1];
	if (last === undefined) {
		return { samples: [], start: 0, end: 0 };
	}
	const start = last.t - windowMs;
	let first = samples.length;
	while (first > 0 && (samples[first - 1]?.t ?? -Infinity) >= start) {
		first--;
	}
	return { samples: samples.slice(first), start, end: last.t };
}

function roundField(field: SystemUsageField, value: number): number {
	return field === 'cpu' || field === 'mem' || field === 'disk' ? Math.round(value * 10) / 10 : Math.round(value);
}

/** 点の並びを平均で1点にする（値の無い点は数えない）。 */
export function averageSamples(samples: readonly SystemUsageSample[], t: number): SystemUsageSample {
	const result: MutableSample = { t };
	for (const field of SYSTEM_USAGE_FIELDS) {
		let sum = 0;
		let n = 0;
		for (const sample of samples) {
			const value = sample[field];
			if (value !== undefined && Number.isFinite(value)) {
				sum += value;
				n++;
			}
		}
		if (n > 0) {
			result[field] = roundField(field, sum / n);
		}
	}
	return result;
}

/**
 * `maxPoints` 以下に間引く（等しい数ずつの組の平均）。組は右端から作り、最新の点の組を必ず揃える。
 * 組の時刻は組の末尾の点の時刻（PC と同じ。最後の組の時刻が実際の最新の点と一致するので、次の `since` に使っても二重に数えない）。
 */
export function downsampleSamples(samples: readonly SystemUsageSample[], maxPoints: number): SystemUsageSample[] {
	const limit = Math.max(1, Math.floor(maxPoints));
	if (samples.length <= limit) {
		return [...samples];
	}
	const bucket = Math.ceil(samples.length / limit);
	const groups: SystemUsageSample[][] = [];
	for (let end = samples.length; end > 0; end -= bucket) {
		groups.unshift(samples.slice(Math.max(0, end - bucket), end));
	}
	return groups.flatMap(group => {
		const last = group[group.length - 1];
		return last !== undefined ? [averageSamples(group, last.t)] : [];
	});
}

/** 点の並びのうち、その項目の最大。 */
export function maxOf(samples: readonly SystemUsageSample[], fields: readonly SystemUsageField[]): number | undefined {
	let max: number | undefined;
	for (const sample of samples) {
		for (const field of fields) {
			const value = sample[field];
			if (value !== undefined && Number.isFinite(value) && (max === undefined || value > max)) {
				max = value;
			}
		}
	}
	return max;
}

export type SystemUsageUnit = 'percent' | 'rate' | 'bytes';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** 縦軸の上端。% は 100、スワップは総量、速度は最大の少し上の 2 の冪。 */
export function axisMax(unit: SystemUsageUnit, max: number | undefined, total?: number): number {
	if (unit === 'percent') {
		return 100;
	}
	if (unit === 'bytes' && total !== undefined && total > 0) {
		return Math.max(total, max ?? 0);
	}
	const top = Math.max(max ?? 0, unit === 'rate' ? KB : MB);
	return Math.pow(2, Math.ceil(Math.log2(top * 1.1)));
}

export function formatRate(bytesPerSecond: number): string {
	const value = Math.max(0, bytesPerSecond);
	if (value < KB) {
		return `${Math.round(value)} B/s`;
	}
	if (value < MB) {
		return `${(value / KB).toFixed(value < 10 * KB ? 1 : 0)} KB/s`;
	}
	if (value < GB) {
		return `${(value / MB).toFixed(value < 10 * MB ? 1 : 0)} MB/s`;
	}
	return `${(value / GB).toFixed(2)} GB/s`;
}

function formatSize(bytes: number): string {
	const value = Math.max(0, bytes);
	if (value < MB) {
		return `${Math.round(value / KB)} KB`;
	}
	if (value < GB) {
		return `${(value / MB).toFixed(value < 10 * MB ? 1 : 0)} MB`;
	}
	return `${(value / GB).toFixed(value < 10 * GB ? 2 : 1)} GB`;
}

export function formatUsageValue(value: number | undefined, unit: SystemUsageUnit): string {
	if (value === undefined || !Number.isFinite(value)) {
		return '—';
	}
	switch (unit) {
		case 'percent': return `${Math.round(value)}%`;
		case 'rate': return formatRate(value);
		case 'bytes': return formatSize(value);
	}
}

export interface SystemUsageMetricSpec {
	readonly id: SystemUsageMetric;
	readonly label: string;
	readonly unit: SystemUsageUnit;
	readonly series: readonly { readonly field: SystemUsageField; readonly label: string }[];
}

export const SYSTEM_USAGE_METRICS: readonly SystemUsageMetricSpec[] = [
	{ id: 'cpu', label: 'CPU 使用率', unit: 'percent', series: [{ field: 'cpu', label: 'CPU' }] },
	{ id: 'memory', label: 'メモリ使用率', unit: 'percent', series: [{ field: 'mem', label: 'メモリ' }] },
	{ id: 'disk', label: 'ディスク使用率', unit: 'percent', series: [{ field: 'disk', label: 'ディスク' }] },
	{ id: 'diskIo', label: 'ディスク I/O', unit: 'rate', series: [{ field: 'diskRead', label: '読み' }, { field: 'diskWrite', label: '書き' }] },
	{ id: 'network', label: '帯域幅', unit: 'rate', series: [{ field: 'netRx', label: '受信' }, { field: 'netTx', label: '送信' }] },
	{ id: 'swap', label: 'スワップ使用量', unit: 'bytes', series: [{ field: 'swapUsed', label: 'スワップ' }] },
];

/**
 * グラフの線（viewBox 幅 `width`・高さ `height` の座標）。値の無い点や `gapMs` より空いた所で線を切る。
 * `area` は 1 本目の面（下端まで閉じた形）。
 */
export function chartPaths(samples: readonly SystemUsageSample[], field: SystemUsageField, start: number, end: number, yMax: number, gapMs: number, width: number, height: number): { readonly line: string; readonly area: string } {
	const span = Math.max(1, end - start);
	const x = (t: number) => Math.round(((t - start) / span) * width * 10) / 10;
	const y = (value: number) => Math.round((height - Math.min(1, Math.max(0, value / Math.max(yMax, Number.EPSILON))) * height) * 10) / 10;
	const line: string[] = [];
	const area: string[] = [];
	let run: { x: number; y: number }[] = [];
	let previousT: number | undefined;
	const flush = () => {
		const first = run[0];
		const last = run[run.length - 1];
		if (first === undefined || last === undefined) {
			return;
		}
		const points = run.map(point => `${point.x},${point.y}`).join('L');
		line.push(`M${points}`);
		area.push(`M${first.x},${height}L${points}L${last.x},${height}Z`);
		run = [];
	};
	for (const sample of samples) {
		const value = sample[field];
		const valid = value !== undefined && Number.isFinite(value);
		if (!valid || (previousT !== undefined && sample.t - previousT > gapMs)) {
			flush();
		}
		if (valid && value !== undefined) {
			run.push({ x: x(sample.t), y: y(value) });
		}
		previousT = sample.t;
	}
	flush();
	return { line: line.join(''), area: area.join('') };
}

/** 「システム」画面で選べるマシン（この PC と、その PC が開いている SSH の接続先）。 */
export interface SystemMachine {
	/** `local` か、接続先の `RelayHost.id`。 */
	readonly key: string;
	readonly label: string;
	/** 要求を送るウィンドウ（この PC で応答できるウィンドウが無ければ undefined＝PC の既定のウィンドウ）。 */
	readonly windowId: number | undefined;
	readonly ready: boolean;
	readonly remote: boolean;
}

export const LOCAL_MACHINE_KEY = 'local';

/**
 * 「システム」画面がそのマシンを選んでいるときの `sysres` の付け足し。送り先は、この PC ならこの PC のウィンドウ
 * （無ければ PC の既定のウィンドウ）、接続先ならその接続先のウィンドウ。どちらでも `history.machine` で名指しするので、
 * PC に SSH のウィンドウしか無くても「この PC」に接続先の値が混ざらない。
 */
export function systemResourcesOptionsFor(machine: SystemMachine, copy: SystemUsageCopy, tier: SystemUsageTier): { readonly windowId?: number; readonly history: SystemUsageHistoryRequest } {
	return {
		...(machine.windowId !== undefined ? { windowId: machine.windowId } : {}),
		history: historyRequestFor(copy, tier, machine.remote ? 'remote' : 'local'),
	};
}

/** 応答がそのマシンの値か（違うマシンの応答は写しに入れない。`historyMachine` の無い応答は受け入れる）。 */
export function responseMatchesMachine(historyMachine: unknown, machine: SystemMachine): boolean {
	return historyMachine === undefined || historyMachine === (machine.remote ? 'remote' : 'local');
}

/** PC 1 台ぶんの使用量の送り先（`PcUsageTarget`）からマシンの一覧を作る。この PC が先頭。 */
export function systemMachinesFor(
	target: { readonly localWindowId: number | undefined; readonly remotes: readonly { readonly id: string; readonly label: string; readonly windowId: number; readonly ready: boolean }[] } | undefined,
	localLabel: string,
): SystemMachine[] {
	return [
		{ key: LOCAL_MACHINE_KEY, label: localLabel, windowId: target?.localWindowId, ready: true, remote: false },
		...(target?.remotes ?? []).map(host => ({ key: host.id, label: host.label, windowId: host.windowId, ready: host.ready, remote: true })),
	];
}

/**
 * 最初に選んでおくマシン。「PC ごと」の SSH の行から来た（`ssh:<pcId>:<hostId>`）ならその接続先、PC が 1 台で
 * 使用量の接続先に SSH を選んでいたらその接続先、どちらでもなければこの PC。一覧に無い接続先は選ばない。
 */
export function initialSystemMachineKey(scopeKey: string, pcId: string | undefined, selectedRemoteHostId: string | undefined, machines: readonly SystemMachine[]): string {
	const prefix = pcId !== undefined ? `ssh:${pcId}:` : undefined;
	const fromScope = prefix !== undefined && scopeKey.startsWith(prefix) ? scopeKey.slice(prefix.length) : undefined;
	const wanted = fromScope ?? selectedRemoteHostId;
	return wanted !== undefined && machines.some(machine => machine.remote && machine.key === wanted) ? wanted : LOCAL_MACHINE_KEY;
}
