import type { ParsedCommand } from '../types/app';

const GUID_RE = '\\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\\}';

/**
 * Parse an UninstallString the way the Go `internal/uninstaller` package does:
 *  - `MsiExec.exe /I{GUID}` and `/X{GUID}` are normalised to `msiexec.exe /x {GUID}`;
 *    `quiet` appends `/qn /norestart`.
 *  - Quoted program paths are honoured ("C:\Program Files\X\unins.exe" /SILENT).
 *  - Unquoted paths containing spaces are split at the first `.exe` boundary.
 */
export function parseUninstallCommand(command: string | undefined, quiet = false): ParsedCommand | undefined {
  if (!command) return undefined;
  const s = command.trim();
  if (!s) return undefined;

  const msi = s.match(new RegExp(`^\\s*"?[^"\\r\\n]*?msiexec(?:\\.exe)?"?\\s+[/-]\\s*([ix])\\s*(${GUID_RE})(.*)$`, 'i'));
  if (msi) {
    const code = msi[2].toUpperCase();
    const extra = msi[3].trim();
    const parts = ['/x', code];
    if (extra) parts.push(extra);
    if (quiet) {
      const lowerExtra = extra.toLowerCase();
      if (!lowerExtra.includes('/qn') && !lowerExtra.includes('/quiet')) parts.push('/qn');
      if (!lowerExtra.includes('/norestart')) parts.push('/norestart');
    }
    const args = parts.join(' ');
    return { program: 'msiexec.exe', args, isMsi: true, normalized: `msiexec.exe ${args}` };
  }

  let program: string;
  let args: string;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    program = end > 0 ? s.slice(1, end) : s.slice(1);
    args = end > 0 ? s.slice(end + 1).trim() : '';
  } else {
    const m = s.match(/^(.*?\.(?:exe|cmd|bat|msi))(\s+.*)?$/i);
    if (m) {
      program = m[1];
      args = (m[2] ?? '').trim();
    } else {
      const i = s.indexOf(' ');
      program = i > 0 ? s.slice(0, i) : s;
      args = i > 0 ? s.slice(i + 1).trim() : '';
    }
  }

  const quotedProgram = program.includes(' ') ? `"${program}"` : program;
  const normalized = args ? `${quotedProgram} ${args}` : quotedProgram;
  return {
    program,
    args,
    isMsi: /msiexec(\.exe)?$/i.test(program),
    normalized,
  };
}

/** Extract "C:\path\app.exe" from a DisplayIcon value such as `C:\path\app.exe,0`. */
export function executableFromDisplayIcon(displayIcon?: string): string | undefined {
  if (!displayIcon) return undefined;
  let s = displayIcon.trim().replace(/^"|"$/g, '');
  const m = s.match(/^(.*?\.(?:exe|dll|ico))(?:,-?\d+)?$/i);
  if (m) s = m[1];
  return s || undefined;
}
