import { useEffect } from 'react';
import { AppTable } from './components/AppTable';
import { ContextMenu } from './components/ContextMenu';
import { DetailPanel } from './components/DetailPanel';
import { DialogHost } from './components/dialogs/DialogHost';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { SEARCH_INPUT_ID, Toolbar } from './components/Toolbar';
import { Toasts } from './components/Toasts';
import { useAppStore } from './store/useAppStore';
import { cn } from './utils/cn';

/** 主题只改 <html> 上的 data-theme，颜色全部来自 index.css 的 CSS 变量。 */
function useTheme() {
  const theme = useAppStore((s) => s.settings.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && mq.matches);
      if (dark) document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

function useLanguage() {
  const language = useAppStore((s) => s.settings.language);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title = language === 'zh-CN' ? '拂尘 Duster · 已安装软件管理与残留清理' : 'Duster · Software manager & leftover cleaner';
  }, [language]);
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useAppStore.getState();
      if (s.dialog.type !== 'none') return;
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        document.getElementById(SEARCH_INPUT_ID)?.focus();
        return;
      }
      if (e.key === 'F5') {
        e.preventDefault();
        void s.refresh();
        return;
      }
      if (typing) return;
      if (e.key === 'Escape') {
        if (s.contextMenu) s.closeContextMenu();
        else s.clearSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default function App() {
  const init = useAppStore((s) => s.init);
  const detailOpen = useAppStore((s) => s.detailOpen);
  useTheme();
  useLanguage();
  useGlobalShortcuts();

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <div
      className="flex h-screen w-screen flex-col overflow-hidden bg-app text-fg antialiased"
      onContextMenu={(e) => {
        // Only table rows open the app menu; suppress the browser menu elsewhere for a native feel.
        if (!(e.target as HTMLElement).closest('input, textarea, a, [data-native-menu]')) e.preventDefault();
      }}
    >
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <AppTable />
        </main>
        <aside
          className={cn(
            'hidden shrink-0 border-l border-stroke bg-card transition-[width] duration-200 lg:block',
            detailOpen ? 'w-[340px] xl:w-[380px]' : 'w-0 overflow-hidden border-l-0',
          )}
        >
          {detailOpen && <DetailPanel />}
        </aside>
      </div>
      <StatusBar />
      <ContextMenu />
      <DialogHost />
      <Toasts />
    </div>
  );
}
