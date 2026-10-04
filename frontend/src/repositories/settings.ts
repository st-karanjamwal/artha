import { one, run } from '@/db/sql';
import { nowUtc } from '@/lib/dates';

export interface AppSettings {
  autoLockMinutes: number;
  lockOnHide: boolean;
  revealRequiresPassphrase: boolean;
}

export function getSetting(key: string): string | undefined {
  return one<{ Value: string }>('SELECT Value FROM AppSettings WHERE Key = ?', [key])?.Value;
}

export function setSetting(key: string, value: string) {
  run(
    `INSERT INTO AppSettings (Key, Value, UpdatedOn) VALUES (?, ?, ?)
     ON CONFLICT(Key) DO UPDATE SET Value = excluded.Value, UpdatedOn = excluded.UpdatedOn`,
    [key, value, nowUtc()],
  );
}

export function getAppSettings(): AppSettings {
  return {
    autoLockMinutes: Math.max(1, Number(getSetting('AutoLockMinutes') ?? 5)),
    lockOnHide: getSetting('LockOnHide') === '1',
    revealRequiresPassphrase: getSetting('RevealRequiresPassphrase') === '1',
  };
}

export function saveAppSettings(s: AppSettings) {
  setSetting('AutoLockMinutes', String(s.autoLockMinutes));
  setSetting('LockOnHide', s.lockOnHide ? '1' : '0');
  setSetting('RevealRequiresPassphrase', s.revealRequiresPassphrase ? '1' : '0');
}
