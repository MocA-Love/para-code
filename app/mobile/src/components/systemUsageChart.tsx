// PARA-CODE: fork-owned file (Para Code) — not present in upstream microsoft/vscode. See CLAUDE.md.

import { memo, useMemo, useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Path } from 'react-native-svg';
import {
	axisMax,
	chartPaths,
	downsampleSamples,
	formatUsageValue,
	maxOf,
	type SystemUsageMetricSpec,
	type SystemUsageSample,
} from '../systemUsageHistory.js';
import { colors, radius, space, type } from '../theme.js';

/** 1 本目（面＋線）と 2 本目（線だけ）の色。 */
export const SYSTEM_USAGE_SERIES_COLORS = [colors.blue, colors.orange] as const;

const CHART_HEIGHT = 72;
/** 1pt あたりに描く点の数の上限（これより細かい点は見分けられない）。 */
const POINTS_PER_PT = 0.5;

export interface SystemUsageChartProps {
	readonly spec: SystemUsageMetricSpec;
	readonly samples: readonly SystemUsageSample[];
	readonly latest: SystemUsageSample | undefined;
	readonly windowStart: number;
	readonly windowEnd: number;
	readonly windowMs: number;
	readonly stepMs: number;
	/** この OS では取れない。 */
	readonly unsupported: boolean;
	/** 接続先の Para Code が古く、今の値しか無い。 */
	readonly legacy: boolean;
	readonly swapTotal: number | undefined;
	/** 2 行目に添える補足（CPU の「Para Code 1%」、メモリの「60.6 GB / 121.5 GB」など）。無ければ出さない。 */
	readonly detail?: string | undefined;
}

/**
 * 「システム」画面の 1 項目のグラフ（折れ線と面）。値が変わらない更新では描き直さない（`memo` と、点の時刻で決まる鍵）。
 * 幅は自分の `onLayout` で測る（画面の幅を本文の幅と思わない。iPad の詳細の列は左の列で幅が変わる）。
 */
export const SystemUsageChart = memo(function SystemUsageChart(props: SystemUsageChartProps) {
	const { spec, samples, latest, windowStart, windowEnd, windowMs, stepMs, unsupported, legacy, swapTotal, detail } = props;
	const [width, setWidth] = useState(0);
	const onLayout = (event: LayoutChangeEvent) => {
		const next = Math.round(event.nativeEvent.layout.width);
		if (next !== width) {
			setWidth(next);
		}
	};
	const fields = spec.series.map(series => series.field);
	const max = maxOf(samples, fields);
	const showLines = !unsupported && !legacy && samples.length >= 2 && width > 0;
	const paths = useMemo(() => {
		if (!showLines) {
			return [];
		}
		const maxPoints = Math.max(30, Math.floor(width * POINTS_PER_PT));
		const points = downsampleSamples(samples, maxPoints);
		const yMax = axisMax(spec.unit, max, spec.id === 'swap' ? swapTotal : undefined);
		// 間引いた 1 点の幅の 3 倍より空いていたら、測っていなかった（スリープ等）とみなして線を切る
		const gapMs = Math.max(stepMs, windowMs / maxPoints) * 3;
		return spec.series.map(series => chartPaths(points, series.field, windowStart, windowEnd, yMax, gapMs, width, CHART_HEIGHT));
	}, [showLines, width, samples, spec, max, swapTotal, stepMs, windowMs, windowStart, windowEnd]);

	const current = spec.series.map(series => (unsupported ? '—' : formatUsageValue(latest?.[series.field], spec.unit)));
	const note = unsupported
		? 'このマシンでは取得できません'
		: legacy
			? '接続先の Para Code を更新すると推移が出ます'
			: samples.length < 2 ? '記録しています…' : undefined;
	const accessibilityLabel = `${spec.label} ${spec.series.map((series, index) => (spec.series.length > 1 ? `${series.label} ${current[index]}` : current[index])).join('、')}${detail !== undefined ? `、${detail}` : ''}${max !== undefined && !unsupported ? `、最大 ${formatUsageValue(max, spec.unit)}` : ''}`;

	return (
		<View style={styles.card} accessible accessibilityLabel={accessibilityLabel}>
			<View style={styles.head}>
				<Text style={styles.label} numberOfLines={1}>{spec.label}</Text>
				{spec.series.length === 1 ? <Text style={styles.value}>{current[0]}</Text> : null}
			</View>
			<View style={styles.sub}>
				{spec.series.length > 1 ? spec.series.map((series, index) => (
					<View key={series.field} style={styles.legend}>
						<View style={[styles.dot, { backgroundColor: SYSTEM_USAGE_SERIES_COLORS[index] ?? colors.blue }]} />
						<Text style={styles.subText}>{series.label} {current[index]}</Text>
					</View>
				)) : null}
				{detail !== undefined ? <Text style={styles.subText}>{detail}</Text> : null}
				{max !== undefined && !unsupported && !legacy ? <Text style={styles.subText}>最大 {formatUsageValue(max, spec.unit)}</Text> : null}
			</View>
			<View style={styles.chart} onLayout={onLayout}>
				{width > 0 ? (
					<Svg width={width} height={CHART_HEIGHT}>
						{[0.25, 0.5, 0.75].map(fraction => (
							<Line key={fraction} x1={0} x2={width} y1={CHART_HEIGHT * fraction} y2={CHART_HEIGHT * fraction} stroke={colors.border} strokeWidth={StyleSheet.hairlineWidth} strokeDasharray="2 3" />
						))}
						{paths[0] !== undefined && paths[0].area.length > 0 ? <Path d={paths[0].area} fill={SYSTEM_USAGE_SERIES_COLORS[0]} fillOpacity={0.18} /> : null}
						{paths.map((path, index) => (path.line.length > 0 ? (
							<Path key={index} d={path.line} fill="none" stroke={SYSTEM_USAGE_SERIES_COLORS[index] ?? colors.blue} strokeWidth={1.5} strokeLinejoin="round" />
						) : null))}
					</Svg>
				) : null}
			</View>
			{note !== undefined ? <Text style={styles.note}>{note}</Text> : null}
		</View>
	);
}, (prev, next) => (
	// 5 秒ごとの取り直しで点が増えていなければ描き直さない（配列は毎回作り直されるので中身の印で比べる）
	prev.spec === next.spec
	&& prev.unsupported === next.unsupported
	&& prev.legacy === next.legacy
	&& prev.swapTotal === next.swapTotal
	&& prev.detail === next.detail
	&& prev.windowMs === next.windowMs
	&& prev.windowStart === next.windowStart
	&& prev.windowEnd === next.windowEnd
	&& prev.samples.length === next.samples.length
	&& prev.samples[0]?.t === next.samples[0]?.t
	&& prev.latest?.t === next.latest?.t
));

const styles = StyleSheet.create({
	card: {
		paddingVertical: space.sm + 2,
		paddingHorizontal: space.md,
		borderRadius: radius.card,
		backgroundColor: colors.panel,
	},
	head: {
		flexDirection: 'row',
		alignItems: 'baseline',
		justifyContent: 'space-between',
		gap: space.sm,
	},
	label: {
		flex: 1,
		minWidth: 0,
		fontSize: type.label,
		fontWeight: '500',
		color: colors.text,
	},
	value: {
		fontSize: type.label,
		fontWeight: '600',
		color: colors.text,
		fontVariant: ['tabular-nums'],
	},
	sub: {
		flexDirection: 'row',
		flexWrap: 'wrap',
		alignItems: 'center',
		columnGap: space.md,
		rowGap: 2,
		minHeight: 16,
		marginTop: 2,
	},
	legend: {
		flexDirection: 'row',
		alignItems: 'center',
		gap: space.xs,
	},
	dot: {
		width: 6,
		height: 6,
		borderRadius: radius.pill,
	},
	subText: {
		fontSize: type.caption,
		color: colors.textMuted,
		fontVariant: ['tabular-nums'],
	},
	chart: {
		height: CHART_HEIGHT,
		marginTop: space.xs,
	},
	note: {
		marginTop: space.xs,
		fontSize: type.caption,
		color: colors.textMuted,
	},
});
