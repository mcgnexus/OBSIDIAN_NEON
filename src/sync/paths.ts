export function validatePath(path: string): boolean {
  if (!path || path.length > 1024 || !path.endsWith('.md')) return false;
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) return false;
  const parts = path.split('/');
  if (parts.some(p => p === '' || p.startsWith('.') || /[. ]$/.test(p))) return false;
  if (parts.some(p => /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))) return false;
  if (/[<>:"|?*\x00-\x1f]/.test(path)) return false;
  return true;
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function isReserved(path: string): boolean {
  return path.startsWith('.obsidian/') || path.startsWith('.trash/');
}
