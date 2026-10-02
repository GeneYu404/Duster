import { useEffect, type ButtonHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Check, Loader2, Minus, X } from 'lucide-react';
import { cn } from '../utils/cn';

/* ---------------------------------- Button --------------------------------- */

type Variant = 'primary' | 'danger' | 'default' | 'ghost' | 'subtle';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variantClass: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover active:opacity-90 border-transparent',
  danger: 'bg-danger-solid text-white hover:bg-danger-solid-hover active:opacity-90 border-transparent',
  default: 'bg-card text-fg border-stroke hover:bg-card-hover active:bg-subtle-press shadow-sm',
  ghost: 'bg-transparent border-transparent text-fg2 hover:bg-subtle active:bg-subtle-press',
  subtle: 'bg-subtle border-transparent text-fg hover:bg-subtle-press',
};

export function Button({ variant = 'default', size = 'md', loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
        variantClass[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export function IconButton({ label, active, className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-md text-fg2 transition-colors hover:bg-subtle hover:text-fg focus:outline-none disabled:opacity-40',
        active && 'bg-accent-soft text-accent',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* --------------------------------- Checkbox -------------------------------- */

interface CheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  description?: ReactNode;
  className?: string;
}

export function Checkbox({ checked, indeterminate, onChange, disabled, label, description, className }: CheckboxProps) {
  return (
    <label className={cn('flex cursor-pointer items-start gap-2.5 text-[13px]', disabled && 'cursor-not-allowed opacity-50', className)}>
      <span
        role="checkbox"
        aria-checked={indeterminate ? 'mixed' : checked}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onChange?.(!checked);
          }
        }}
        onClick={(e) => {
          e.preventDefault();
          if (!disabled) onChange?.(!checked);
        }}
        className={cn(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors focus:outline-none',
          checked || indeterminate ? 'border-accent bg-accent text-on-accent' : 'border-fg2 bg-card',
        )}
      >
        {indeterminate ? <Minus className="h-3 w-3" strokeWidth={3} /> : checked ? <Check className="h-3 w-3" strokeWidth={3} /> : null}
      </span>
      {(label || description) && (
        <span className="min-w-0 select-none" onClick={(e) => { e.preventDefault(); if (!disabled) onChange?.(!checked); }}>
          {label && <span className="block text-fg">{label}</span>}
          {description && <span className="block text-xs text-fg2">{description}</span>}
        </span>
      )}
    </label>
  );
}

/* ---------------------------------- Toggle --------------------------------- */

interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: ReactNode;
  description?: ReactNode;
}

export function Toggle({ checked, onChange, disabled, label, description }: ToggleProps) {
  return (
    <div className={cn('flex items-center justify-between gap-4 py-2', disabled && 'opacity-60')}>
      <div className="min-w-0">
        <div className="text-[13px] text-fg">{label}</div>
        {description && <div className="text-xs text-fg2">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full border transition-colors focus:outline-none disabled:cursor-not-allowed',
          checked ? 'border-transparent bg-accent' : 'border-fg2 bg-transparent hover:bg-subtle',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-4 w-4 rounded-full shadow transition-transform',
            checked ? 'translate-x-4 bg-on-accent' : 'bg-fg2',
          )}
        />
      </button>
    </div>
  );
}

/* --------------------------------- Segmented ------------------------------- */

interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  className?: string;
}

export function Segmented<T extends string>({ value, options, onChange, className }: SegmentedProps<T>) {
  return (
    <div className={cn('inline-flex rounded-md border border-stroke bg-card p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded px-3 py-1 text-xs font-medium transition-colors',
            value === o.value ? 'bg-accent text-on-accent' : 'text-fg2 hover:bg-subtle hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------------- Select -------------------------------- */

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-8 rounded-md border border-stroke bg-card px-2 text-[13px] text-fg hover:bg-card-hover focus:outline-none',
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

/* ----------------------------------- Badge --------------------------------- */

type Tone = 'neutral' | 'indigo' | 'green' | 'amber' | 'red' | 'sky' | 'violet' | 'pink';

const toneClass: Record<Tone, string> = {
  neutral: 'bg-subtle text-fg2',
  indigo: 'bg-accent-soft text-accent',
  green: 'bg-success-soft text-success',
  amber: 'bg-warning-soft text-warning',
  red: 'bg-danger-soft text-danger',
  sky: 'bg-info-soft text-info',
  violet: 'bg-brand-soft text-brand',
  pink: 'bg-game-soft text-game',
};

export function Badge({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-px text-[10px] font-semibold tracking-wide uppercase', toneClass[tone], className)}>
      {children}
    </span>
  );
}

export const KIND_TONE: Record<string, Tone> = {
  program: 'neutral',
  msi: 'sky',
  store: 'violet',
  game: 'pink',
  system: 'amber',
  update: 'green',
};

/* ---------------------------------- Spinner -------------------------------- */

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-accent', className)} />;
}

/* ----------------------------------- Modal --------------------------------- */

interface ModalProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** When busy the dialog cannot be dismissed by Esc / overlay click. */
  busy?: boolean;
  bodyClassName?: string;
}

const sizeClass = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' };

export function Modal({ title, subtitle, icon, children, footer, onClose, size = 'md', busy, bodyClassName }: ModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [busy, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4 backdrop-blur-[2px] animate-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'flex w-full flex-col overflow-hidden rounded-xl border border-stroke bg-dialog text-fg shadow-dialog max-h-[90vh]',
          sizeClass[size],
        )}
      >
        <div className="flex items-start gap-3 border-b border-stroke px-5 py-3.5">
          {icon && <div className="mt-0.5 shrink-0">{icon}</div>}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold">{title}</h2>
            {subtitle && <div className="mt-0.5 truncate text-xs text-fg2">{subtitle}</div>}
          </div>
          <IconButton label="Close" onClick={onClose} disabled={busy} className="-mr-2 h-7 w-7">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className={cn('win-scroll min-h-0 flex-1 overflow-auto px-5 py-4', bodyClassName)}>{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-stroke bg-dialog-footer px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------------------------- Field ---------------------------------- */

export function Field({ label, children, mono, className }: { label: ReactNode; children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={cn('grid grid-cols-[112px_1fr] items-start gap-x-3 gap-y-0.5 py-1.5 text-[13px]', className)}>
      <div className="pt-px text-xs text-fg2">{label}</div>
      <div className={cn('min-w-0 break-all text-fg', mono && 'font-mono text-[12px]')}>{children}</div>
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mt-4 mb-1 text-[11px] font-semibold tracking-wider text-fg3 uppercase first:mt-0">{children}</h3>;
}

/* ----------------------------------- Kbd ----------------------------------- */

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-stroke bg-subtle px-1 font-sans text-[10px] text-fg2">{children}</kbd>
  );
}
