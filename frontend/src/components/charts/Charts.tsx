import type { ReactNode } from 'react';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { axisClasses } from '@mui/x-charts/ChartsAxis';
import { chartsGridClasses } from '@mui/x-charts/ChartsGrid';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import { PieChart } from '@mui/x-charts/PieChart';
import type { SeriesPoint } from '@/api/types';
import { fmtNumber } from '@/utils/format';

/** Chart colours: near-black for the main series, green for the positive one, red only for problems. */
export const INK = '#111111';
export const GREEN = '#22a64c';
export const RED = '#dc2626';
export const AMBER = '#d97706';
export const GREY = '#c9c9c3';

// MUI X Charts reads fonts and text colours from a MUI theme; keep it matched to the app (Inter, neutral greys).
const chartTheme = createTheme({
  typography: { fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', fontSize: 12 },
  palette: { text: { primary: '#111111', secondary: '#737373' } },
});

const chartSx = {
  [`& .${axisClasses.line}, & .${axisClasses.tick}`]: { stroke: '#e7e7e3' },
  [`& .${axisClasses.tickLabel}`]: { fill: '#737373', fontSize: 12 },
  [`& .${chartsGridClasses.line}`]: { stroke: '#e7e7e3', strokeDasharray: 'none' },
} as const;

export function shortLabel(label: string) {
  if (/T\d{2}:00$/.test(label)) return label.slice(11, 16);
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    const d = new Date(`${label}T00:00:00`);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  if (/^\d{4}-\d{2}$/.test(label)) return new Date(`${label}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short' });
  return label;
}

/** Axis ticks such as 12.5k. */
export const compact = (v: number) => (Math.abs(v) >= 1000 ? `${Math.round(v / 100) / 10}k` : String(v));

function Frame({ children }: { children: ReactNode }) {
  return <ThemeProvider theme={chartTheme}>{children}</ThemeProvider>;
}

type Row = Record<string, string | number | null>;

export interface ChartSeries {
  key: string;
  label: string;
  color?: string;
  /** Line charts only: fill under the line. */
  area?: boolean;
  format?: (v: number) => string;
}

const legend = { direction: 'horizontal', position: { vertical: 'top', horizontal: 'start' }, sx: { fontSize: 12 } } as const;

/** Time series (lines, optionally with an area): messages per day, inventory flow, revenue and costs. */
export function TrendChart({ data, xKey, xFormat = shortLabel, series, height = 260, hideLegend }: { data: Row[]; xKey: string; xFormat?: (v: string) => string; series: ChartSeries[]; height?: number; hideLegend?: boolean }) {
  return (
    <Frame>
      <LineChart
        height={height}
        dataset={data}
        xAxis={[{ scaleType: 'point', dataKey: xKey, valueFormatter: (v: string) => xFormat(String(v)), tickLabelMinGap: 12 }]}
        yAxis={[{ width: 44, valueFormatter: (v: number) => compact(v) }]}
        series={series.map((s) => ({ dataKey: s.key, label: s.label, color: s.color ?? INK, area: s.area, showMark: false, curve: 'monotoneX', valueFormatter: (v: number | null) => (v == null ? '' : (s.format ?? fmtNumber)(v)) }))}
        grid={{ horizontal: true }}
        hideLegend={hideLegend}
        slotProps={{ legend }}
        margin={{ top: 16, right: 12, bottom: 8, left: 4 }}
        sx={{ ...chartSx, '& .MuiAreaElement-root': { fillOpacity: 0.18 }, '& .MuiLineElement-root': { strokeWidth: 2 } }}
      />
    </Frame>
  );
}

/** Daily or monthly counts as bars. */
export function CountBarChart({ data, xKey, xFormat = shortLabel, series, height = 220, hideLegend }: { data: Row[]; xKey: string; xFormat?: (v: string) => string; series: ChartSeries[]; height?: number; hideLegend?: boolean }) {
  return (
    <Frame>
      <BarChart
        height={height}
        dataset={data}
        xAxis={[{ scaleType: 'band', dataKey: xKey, valueFormatter: (v: string) => xFormat(String(v)), tickLabelMinGap: 12, categoryGapRatio: 0.4, barGapRatio: 0.1 }]}
        yAxis={[{ width: 44, valueFormatter: (v: number) => compact(v) }]}
        series={series.map((s) => ({ dataKey: s.key, label: s.label, color: s.color ?? INK, valueFormatter: (v: number | null) => (v == null ? '' : (s.format ?? fmtNumber)(v)) }))}
        grid={{ horizontal: true }}
        hideLegend={hideLegend ?? series.length < 2}
        slotProps={{ legend }}
        borderRadius={3}
        margin={{ top: 16, right: 12, bottom: 8, left: 4 }}
        sx={chartSx}
      />
    </Frame>
  );
}

export function SmsTrendChart({ data, height = 260 }: { data: SeriesPoint[]; height?: number }) {
  return (
    <TrendChart
      data={data as unknown as Row[]}
      xKey="label"
      height={height}
      series={[
        { key: 'total', label: 'Sent', color: INK },
        { key: 'delivered', label: 'Delivered', color: GREEN, area: true },
        { key: 'failed', label: 'Failed', color: RED },
      ]}
    />
  );
}

export function RevenueChart({ data, currency, height = 260 }: { data: { label: string; revenue: string }[]; currency: string; height?: number }) {
  const rows = data.map((d) => ({ label: d.label, revenue: Number(d.revenue) }));
  return <CountBarChart data={rows} xKey="label" height={height} series={[{ key: 'revenue', label: 'Revenue', color: INK, format: (v) => `${currency} ${fmtNumber(v)}` }]} />;
}

export function GrowthChart({ data, height = 220 }: { data: { label: string; signups: number; approved: number }[]; height?: number }) {
  return (
    <CountBarChart
      data={data}
      xKey="label"
      height={height}
      series={[
        { key: 'signups', label: 'Sign-ups', color: GREY },
        { key: 'approved', label: 'Approved', color: INK },
      ]}
    />
  );
}

export function StatusDonut({ delivered, failed, pending, height = 200 }: { delivered: number; failed: number; pending: number; height?: number }) {
  const data = [
    { id: 'delivered', label: 'Delivered', value: delivered, color: GREEN },
    { id: 'failed', label: 'Failed', value: failed, color: RED },
    { id: 'pending', label: 'Pending', value: pending, color: GREY },
  ].filter((d) => d.value > 0);
  const total = delivered + failed + pending;
  if (total === 0) return <div className="flex items-center justify-center text-sm text-slate-500" style={{ height }}>No messages in this period</div>;
  return (
    <div className="relative" style={{ height }}>
      <Frame>
        <PieChart
          height={height}
          series={[{ data, innerRadius: '62%', outerRadius: '92%', paddingAngle: 2, valueFormatter: (item: { value: number }) => fmtNumber(item.value) }]}
          hideLegend
          margin={{ top: 4, bottom: 4, left: 4, right: 4 }}
        />
      </Frame>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-semibold tabular-nums text-slate-900">{fmtNumber(total)}</span>
        <span className="text-[13px] text-slate-500">messages</span>
      </div>
    </div>
  );
}
