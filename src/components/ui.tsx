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
  primary: 'btn--primary',
  danger: 'btn--danger',
  default: 'btn--default',
  ghost: 'btn--ghost',
  subtle: 'btn--subtle',
};

export function Button({ variant = 'default', size = 'md', loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn('btn t-colors', size === 'sm' ? 'btn--sm' : 'btn--md', variantClass[variant], className)}
      {...rest}
    >
      {loading ? <Loader2 className="btn-spinner" /> : icon}
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
      className={cn('icon-btn t-colors', className, active && 'icon-btn--on')}
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
    <label className={cn('checkbox', disabled && 'is-disabled', className)}>
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
        className={cn('checkbox-box t-colors', checked || indeterminate ? 'checkbox-box--on' : 'checkbox-box--off')}
      >
        {indeterminate ? <Minus className="i12" strokeWidth={3} /> : checked ? <Check className="i12" strokeWidth={3} /> : null}
      </span>
      {(label || description) && (
        <span className="checkbox-text" onClick={(e) => { e.preventDefault(); if (!disabled) onChange?.(!checked); }}>
          {label && <span className="checkbox-label">{label}</span>}
          {description && <span className="checkbox-desc">{description}</span>}
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
    <div className={cn('toggle-row', disabled && 'is-disabled')}>
      <div className="toggle-text">
        <div className="toggle-label">{label}</div>
        {description && <div className="toggle-desc">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('toggle t-colors', checked ? 'toggle--on' : 'toggle--off')}
      >
        <span className={cn('toggle-thumb t-transform', checked ? 'toggle-thumb--on' : 'toggle-thumb--off')} />
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
    <div className={cn('segmented', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn('seg-item t-colors', value === o.value ? 'seg-item--on' : 'seg-item--off')}
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
    <select className={cn('select', className)} {...rest}>
      {children}
    </select>
  );
}

/* ----------------------------------- Badge --------------------------------- */

type Tone = 'neutral' | 'indigo' | 'green' | 'amber' | 'red' | 'sky' | 'violet' | 'pink';

const toneClass: Record<Tone, string> = {
  neutral: 'badge--neutral',
  indigo: 'badge--indigo',
  green: 'badge--green',
  amber: 'badge--amber',
  red: 'badge--red',
  sky: 'badge--sky',
  violet: 'badge--violet',
  pink: 'badge--pink',
};

export function Badge({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={cn('badge', toneClass[tone], className)}>{children}</span>;
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
  return <Loader2 className={cn('spinner', className)} />;
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

const sizeClass = { sm: 'dialog--sm', md: 'dialog--md', lg: 'dialog--lg', xl: 'dialog--xl' };

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
      className="modal-overlay animate-in"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" className={cn('dialog', sizeClass[size])}>
        <div className="dialog-head">
          {icon && <div className="dialog-icon">{icon}</div>}
          <div className="dialog-head-body">
            <h2 className="dialog-title">{title}</h2>
            {subtitle && <div className="dialog-subtitle">{subtitle}</div>}
          </div>
          <IconButton label="Close" onClick={onClose} disabled={busy} className="icon-btn--dialog">
            <X className="i16" />
          </IconButton>
        </div>
        <div className={cn('win-scroll dialog-body', bodyClassName)}>{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------------------------------- Field ---------------------------------- */

export function Field({ label, children, mono, className }: { label: ReactNode; children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={cn('field', className)}>
      <div className="field-label">{label}</div>
      <div className={cn('field-value', mono && 'field-value--mono')}>{children}</div>
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="section-title section-title--dialog">{children}</h3>;
}

/* ----------------------------------- Kbd ----------------------------------- */

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd-inline">{children}</kbd>;
}
