import { App, Plugin, PluginSettingTab, Setting, Notice } from 'obsidian';
import { SyncEngine } from './sync/engine';
import { createNeonStore } from './sync/neon';
import { validatePath } from './sync/paths';

interface NeonSyncSettings {
  connectionUrl: string;
  deviceId: string;
  intervalSeconds: number;
  paused: boolean;
}

const DEFAULT_SETTINGS: NeonSyncSettings = {
  connectionUrl: '', deviceId: '', intervalSeconds: 30, paused: false,
};

export default class NeonSyncPlugin extends Plugin {
  settings: NeonSyncSettings = { ...DEFAULT_SETTINGS };
  engine: SyncEngine | null = null;
  private timer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    if (!this.settings.deviceId) {
      this.settings.deviceId = crypto.randomUUID();
      await this.saveSettings();
    }
    this.addCommand({ id: 'sync-now', name: 'Sincronizar ahora', callback: () => void this.syncNow() });
    this.addSettingTab(new NeonSyncSettingTab(this.app, this));
    const isMd = (p: string) => p.endsWith('.md') && validatePath(p);
    this.registerEvent(this.app.vault.on('create', (file) => {
      if (isMd(file.path)) void this.captureAndEnqueue(file.path, 'put');
    }));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      if (isMd(file.path)) void this.captureAndEnqueue(file.path, 'put');
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (isMd(file.path)) this.engine?.enqueue({ id: crypto.randomUUID(), device: this.settings.deviceId, kind: 'delete', path: file.path });
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (isMd(file.path) && isMd(oldPath)) {
        void (async () => {
          try {
            const content = await this.app.vault.read(file as any);
            this.engine?.enqueue({ id: crypto.randomUUID(), device: this.settings.deviceId, kind: 'rename', path: oldPath, destination: file.path, content });
          } catch { /* ignore */ }
        })();
      }
    }));
    if (this.settings.connectionUrl) this.initializeEngine();
  }

  private async captureAndEnqueue(path: string, kind: 'put'): Promise<void> {
    const engine = this.engine;
    if (!engine) return;
    try {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!file) return;
      const content = await this.app.vault.read(file as any);
      engine.enqueue({ id: crypto.randomUUID(), device: this.settings.deviceId, kind, path, content });
    } catch { /* ignore read errors */ }
  }

  initializeEngine(): void {
    const store = createNeonStore(this.settings.connectionUrl);
    this.engine = new SyncEngine({
      vault: {
        listMarkdown: async () => this.app.vault.getMarkdownFiles().map(f => f.path),
        read: async (p) => (await this.app.vault.read(this.app.vault.getAbstractFileByPath(p) as any)) as string,
        write: async (p, c) => { const f = this.app.vault.getAbstractFileByPath(p); if (f) await this.app.vault.modify(f as any, c); else await this.app.vault.create(p, c); },
        remove: async (p) => { const f = this.app.vault.getAbstractFileByPath(p); if (f) await this.app.vault.delete(f as any); },
        rename: async (a, b) => { const f = this.app.vault.getAbstractFileByPath(a); if (f) await this.app.vault.rename(f as any, b); },
        trash: async (p) => { const f = this.app.vault.getAbstractFileByPath(p); if (f) await this.app.vault.trash(f as any, true); },
        exists: async (p) => !!this.app.vault.getAbstractFileByPath(p),
        hash: async (c) => { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(c)); return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join(''); },
      },
      state: { get: (k) => { try { return JSON.parse(localStorage.getItem('neon-sync:' + k) ?? 'null'); } catch { return null; } }, set: (k, v) => localStorage.setItem('neon-sync:' + k, JSON.stringify(v)), remove: (k) => localStorage.removeItem('neon-sync:' + k) },
      remote: store as any,
      deviceId: this.settings.deviceId,
      onStatus: (s) => new Notice(s, 3000),
      onConflict: (paths) => new Notice('Conflictos no resueltos: ' + paths.join(', '), 8000),
    });
    if (!this.settings.paused) this.startTimer();
  }

  private startTimer(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => void this.syncNow(), this.settings.intervalSeconds * 1000);
  }

  async syncNow(): Promise<void> {
    if (!this.engine || this.settings.paused) return;
    try { await this.engine.syncOnce(); }
    catch (e) { new Notice('Error de sincronizacion. Los cambios pendientes se conservan.', 5000); }
  }

  async loadSettings(): Promise<void> { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  onunload(): void { if (this.timer) window.clearInterval(this.timer); }
}

class NeonSyncSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NeonSyncPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('URL de conexion').setDesc('URL PostgreSQL de un rol restringido de Neon. El contenido se almacena como texto legible.').addText(t => t.setValue(this.plugin.settings.connectionUrl).onChange(async v => { this.plugin.settings.connectionUrl = v; await this.plugin.saveSettings(); if (v) this.plugin.initializeEngine(); }));
    new Setting(containerEl).setName('Intervalo (segundos)').addText(t => t.setValue(String(this.plugin.settings.intervalSeconds)).onChange(async v => { const n = Number(v); if (n >= 10) { this.plugin.settings.intervalSeconds = n; await this.plugin.saveSettings(); } }));
    new Setting(containerEl).setName('Pausar').addToggle(t => t.setValue(this.plugin.settings.paused).onChange(async v => { this.plugin.settings.paused = v; if (v) this.plugin.engine?.pause(); else this.plugin.engine?.resume(); await this.plugin.saveSettings(); if (!v && this.plugin.engine) this.plugin['startTimer'](); }));
    new Setting(containerEl).setName('Sincronizar ahora').addButton(b => b.setButtonText('Sincronizar').onClick(() => void this.plugin.syncNow()));
    containerEl.createEl('p', { text: 'Advertencia: el contenido es legible en Neon, la credencial es accesible desde este dispositivo y la sincronizacion automatica puede mantener el compute activo. La ultima operacion nueva gana, incluidos borrados.' });
  }
}
