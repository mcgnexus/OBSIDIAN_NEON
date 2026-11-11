export function validatePath(path: string): boolean {
  if (!path || path.length > 1024 || !path.endsWith('.md')) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  const parts = path.split('/');
  if (parts.some(p => p === '' || p === '..' || p.startsWith('.') || /[. ]$/.test(p))) return false;
  if (parts.some(p => /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))) return false;
  if (/[<>:"|?*\x00-\x1f]/.test(path)) return false;
  return true;
}

// Detect paths that collide on case-insensitive or Unicode-normalizing file systems.
export function findCollisions(paths: string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const p of paths) {
    const key = p.normalize('NFC').toLowerCase();
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.values()].filter(g => g.length > 1);
}
