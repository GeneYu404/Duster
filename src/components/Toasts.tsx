import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn('toast animate-in', t.kind === 'success' && 'toast--success', t.kind === 'error' && 'toast--error')}
        >
          {t.kind === 'success' ? <CheckCircle2 className="toast-icon i16 c-success" /> : t.kind === 'error' ? <AlertCircle className="toast-icon i16 c-danger" /> : <Info className="toast-icon i16 c-accent" />}
          <span className="toast-msg">{t.message}</span>
          <button type="button" onClick={() => dismiss(t.id)} className="toast-close">
            <X className="i14" />
          </button>
        </div>
      ))}
    </div>
  );
}
