import { useState } from 'react';
import { FolderOpen, Settings as SettingsIcon } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useT } from '../../store/hooks';
import { useAppStore } from '../../store/useAppStore';
import type { Language, LogLevel, Settings, Theme } from '../../types/app';
import { Button, Modal, SectionTitle, Segmented, Select, Toggle } from '../ui';

export function SettingsDialog() {
  const t = useT();
  const closeDialog = useAppStore((s) => s.closeDialog);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const pushToast = useAppStore((s) => s.pushToast);
  const reportError = useAppStore((s) => s.reportError);
  const backend = useAppStore((s) => s.backend);
  const [draft, setDraft] = useState<Settings>(settings);
  const [saving, setSaving] = useState(false);

  const patch = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }));

  const save = async () => {
    setSaving(true);
    await updateSettings(draft);
    setSaving(false);
    pushToast('success', t('st.saved'));
    closeDialog();
  };

  return (
    <Modal
      title={t('st.title')}
      icon={<SettingsIcon className="h-5 w-5 text-accent" />}
      onClose={closeDialog}
      size="lg"
      footer={
        <>
          <Button onClick={closeDialog}>{t('cancel')}</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {t('st.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-x-8 md:grid-cols-2">
        <div>
          <SectionTitle>{t('st.appearance')}</SectionTitle>
          <div className="flex items-center justify-between py-2">
            <span className="text-[13px]">{t('st.theme')}</span>
            <Segmented<Theme>
              value={draft.theme}
              onChange={(theme) => patch({ theme })}
              options={[
                { value: 'light', label: t('st.theme.light') },
                { value: 'dark', label: t('st.theme.dark') },
                { value: 'system', label: t('st.theme.system') },
              ]}
            />
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-[13px]">{t('st.language')}</span>
            <Select value={draft.language} onChange={(e) => patch({ language: e.target.value as Language })}>
              <option value="zh-CN">简体中文</option>
              <option value="en-US">English</option>
            </Select>
          </div>

          <SectionTitle>{t('st.list')}</SectionTitle>
          <Toggle checked={draft.showSystemComponents} onChange={(v) => patch({ showSystemComponents: v })} label={t('st.showSystem')} />
          <Toggle checked={draft.showUpdates} onChange={(v) => patch({ showUpdates: v })} label={t('st.showUpdates')} />
          <Toggle checked={draft.showStoreApps} onChange={(v) => patch({ showStoreApps: v })} label={t('st.showStore')} />

          <SectionTitle>{t('st.privilege')}</SectionTitle>
          <Toggle checked={draft.requestAdminOnStartup} onChange={(v) => patch({ requestAdminOnStartup: v })} label={t('st.requestAdmin')} description={t('st.requestAdminNote')} />
        </div>

        <div>
          <SectionTitle>{t('st.safety')}</SectionTitle>
          <Toggle checked disabled onChange={() => undefined} label={t('st.confirmDelete')} description={t('st.confirmDeleteNote')} />
          <Toggle checked={draft.useRecycleBin} onChange={(v) => patch({ useRecycleBin: v })} label={t('st.recycleBin')} />
          <Toggle checked={draft.enableLeftoverScan} onChange={(v) => patch({ enableLeftoverScan: v })} label={t('st.enableScan')} />
          <Toggle checked={draft.scanAfterUninstall} disabled={!draft.enableLeftoverScan} onChange={(v) => patch({ scanAfterUninstall: v })} label={t('st.scanAfter')} />

          <SectionTitle>{t('st.advanced')}</SectionTitle>
          <div className="flex items-center justify-between py-2">
            <span className="text-[13px]">{t('st.logLevel')}</span>
            <Select value={draft.logLevel} onChange={(e) => patch({ logLevel: e.target.value as LogLevel })}>
              {(['error', 'warn', 'info', 'debug', 'trace'] as LogLevel[]).map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>
          </div>
          <div className="py-2">
            <div className="mb-1 text-[13px]">{t('st.backupDir')}</div>
            <div className="flex gap-1.5">
              <input
                value={draft.backupDirectory}
                onChange={(e) => patch({ backupDirectory: e.target.value })}
                spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-md border border-stroke bg-card px-2 font-mono text-[12px] focus:border-accent focus:outline-none"
              />
              <Button
                icon={<FolderOpen className="h-3.5 w-3.5" />}
                disabled={backend !== 'tauri'}
                title={backend !== 'tauri' ? 'Tauri only' : undefined}
                onClick={() => {
                  void open({ directory: true, multiple: false, defaultPath: draft.backupDirectory })
                    .then((path) => {
                      if (typeof path === 'string') patch({ backupDirectory: path });
                    })
                    .catch(reportError);
                }}
              >
                …
              </Button>
            </div>
          </div>
          <Toggle checked={draft.portableMode} onChange={(v) => patch({ portableMode: v })} label={t('st.portable')} description={t('st.portableNote')} />
        </div>
      </div>
    </Modal>
  );
}
