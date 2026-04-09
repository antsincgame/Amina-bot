import type { FieldProps, StatusRowProps, ToggleButtonProps, PreviewRowProps } from './types';

export const Field = ({ label, children, hint, className }: FieldProps) => (
  <div className={className}>
    <label className="block text-sm font-medium text-gray-300 mb-1.5">{label}</label>
    {children}
    {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
  </div>
);

export const StatusRow = ({ label, value, ok, mono }: StatusRowProps) => (
  <div className="flex items-center justify-between px-4 py-2.5 rounded-xl bg-white/[0.02] border border-white/5">
    <span className="text-sm text-gray-400">{label}</span>
    <span className={`text-sm font-medium ${ok ? 'text-emerald-400' : 'text-red-400'} ${mono ? 'font-mono text-xs' : ''}`}>
      {value}
    </span>
  </div>
);

export const ToggleButton = ({ active, label, iconOn, iconOff, onClick }: ToggleButtonProps) => (
  <button
    type="button"
    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border transition-all ${
      active ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' : 'border-gray-700 bg-gray-800/50 text-gray-500'
    }`}
    onClick={onClick}
  >
    {active ? iconOn : iconOff}
    <span className="text-sm">{label}</span>
  </button>
);

export const PreviewRow = ({ label, value }: PreviewRowProps) => (
  <div>
    <p className="text-xs uppercase tracking-wide text-gray-500 mb-1">{label}</p>
    <div className="rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap">
      {value}
    </div>
  </div>
);
