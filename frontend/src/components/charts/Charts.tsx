import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SeriesPoint } from '@/api/types';
import { fmtNumber } from '@/utils/format';

const axis = { fontSize: 11, fill: '#94a3b8' };

function shortLabel(label: string) {
  if (/T\d{2}:00$/.test(label)) return label.slice(11, 16);
  if (/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    const d = new Date(`${label}T00:00:00`);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  if (/^\d{4}-\d{2}$/.test(label)) return new Date(`${label}-01T00:00:00`).toLocaleDateString('en-US', { month: 'short' });
  return label;
}

function ChartTooltip({ active, payload, label, money }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; money?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg bg-white px-3 py-2 text-xs shadow-pop ring-1 ring-slate-200">
      <p className="mb-1 font-medium text-slate-900">{shortLabel(label ?? '')}</p>
      {payload.map((p) => (
        <p key={p.name} className="flex items-center gap-2 text-slate-600">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          {p.name}: <span className="font-semibold tabular-nums text-slate-900">{money ? `${money} ${fmtNumber(Number(p.value))}` : fmtNumber(p.value)}</span>
        </p>
      ))}
    </div>
  );
}

export function SmsTrendChart({ data, height = 260 }: { data: SeriesPoint[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <defs>
          <linearGradient id="gTotal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity={0.25} />
            <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gDelivered" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity={0.2} />
            <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
        <XAxis dataKey="label" tickFormatter={shortLabel} tick={axis} axisLine={false} tickLine={false} minTickGap={16} />
        <YAxis tick={axis} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip content={<ChartTooltip />} />
        <Area type="monotone" dataKey="total" name="Sent" stroke="#6366f1" strokeWidth={2} fill="url(#gTotal)" />
        <Area type="monotone" dataKey="delivered" name="Delivered" stroke="#10b981" strokeWidth={2} fill="url(#gDelivered)" />
        <Area type="monotone" dataKey="failed" name="Failed" stroke="#ef4444" strokeWidth={1.5} fill="transparent" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function RevenueChart({ data, currency, height = 260 }: { data: { label: string; revenue: string }[]; currency: string; height?: number }) {
  const rows = data.map((d) => ({ label: d.label, revenue: Number(d.revenue) }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
        <XAxis dataKey="label" tickFormatter={shortLabel} tick={axis} axisLine={false} tickLine={false} minTickGap={16} />
        <YAxis tick={axis} axisLine={false} tickLine={false} tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
        <Tooltip content={<ChartTooltip money={currency} />} cursor={{ fill: '#f1f5f9' }} />
        <Bar dataKey="revenue" name="Revenue" fill="url(#gRev)" radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function GrowthChart({ data, height = 220 }: { data: { label: string; signups: number; approved: number }[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
        <XAxis dataKey="label" tickFormatter={shortLabel} tick={axis} axisLine={false} tickLine={false} minTickGap={16} />
        <YAxis tick={axis} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: '#f1f5f9' }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="signups" name="Sign-ups" fill="#a5b4fc" radius={[3, 3, 0, 0]} maxBarSize={18} />
        <Bar dataKey="approved" name="Approved" fill="#4f46e5" radius={[3, 3, 0, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function StatusDonut({ delivered, failed, pending, height = 200 }: { delivered: number; failed: number; pending: number; height?: number }) {
  const data = [
    { name: 'Delivered', value: delivered, color: '#10b981' },
    { name: 'Failed', value: failed, color: '#ef4444' },
    { name: 'Pending', value: pending, color: '#6366f1' },
  ].filter((d) => d.value > 0);
  const total = delivered + failed + pending;
  if (total === 0) return <div className="flex items-center justify-center text-sm text-slate-400" style={{ height }}>No messages in this period</div>;
  return (
    <div className="relative" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" innerRadius="62%" outerRadius="88%" paddingAngle={2} stroke="none">
            {data.map((d) => (
              <Cell key={d.name} fill={d.color} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-semibold tabular-nums text-slate-900">{fmtNumber(total)}</span>
        <span className="text-xs text-slate-500">messages</span>
      </div>
    </div>
  );
}
