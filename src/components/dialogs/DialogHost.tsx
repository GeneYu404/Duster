import { useAppStore } from '../../store/useAppStore';
import { ExportDialog } from './ExportDialog';
import { LeftoverDialog } from './LeftoverDialog';
import { BackupsDialog, DeleteEntryDialog, ErrorDialog, LogsDialog, PropertiesDialog } from './MiscDialogs';
import { SettingsDialog } from './SettingsDialog';
import { UninstallDialog } from './UninstallDialog';

/** Renders whichever modal is currently open. Keyed so re-opening resets local state. */
export function DialogHost() {
  const dialog = useAppStore((s) => s.dialog);
  switch (dialog.type) {
    case 'uninstall':
      return <UninstallDialog key={dialog.appIds.join(',')} appIds={dialog.appIds} quiet={dialog.quiet} />;
    case 'leftovers':
      return <LeftoverDialog key={`${dialog.appId}:${dialog.mode}`} appId={dialog.appId} appName={dialog.appName} mode={dialog.mode} />;
    case 'delete-entry':
      return <DeleteEntryDialog key={dialog.appId} appId={dialog.appId} />;
    case 'settings':
      return <SettingsDialog />;
    case 'export':
      return <ExportDialog scope={dialog.scope} />;
    case 'error':
      return <ErrorDialog title={dialog.title} error={dialog.error} />;
    case 'backups':
      return <BackupsDialog />;
    case 'logs':
      return <LogsDialog />;
    case 'properties':
      return <PropertiesDialog key={dialog.appId} appId={dialog.appId} />;
    default:
      return null;
  }
}
