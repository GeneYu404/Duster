import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { cn } from '../utils/cn';

export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed right-4 bottom-10 z-[60] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-start gap-2.5 rounded-lg border border-stroke bg-acrylic px-3 py-2.5 text-[13px] text-fg shadow-flyout backdrop-blur-2xl animate-in',
            t.kind === 'success' && 'border-success/30',
            t.kind === 'error' && 'border-danger/30',
          )}
        >
          {t.kind === 'success' ? <CheckCircle2 className="mt-px h-4 w-4 shrink-0 text-success" /> : t.kind === 'error' ? <AlertCircle className="mt-px h-4 w-4 shrink-0 text-danger" /> : <Info className="mt-px h-4 w-4 shrink-0 text-accent" />}
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <button type="button" onClick={() => dismiss(t.id)} className="shrink-0 rounded p-0.5 text-fg2 opacity-60 hover:bg-subtle hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
