import { App, FuzzySuggestModal, Notice, PluginSettingTab, Setting, TextComponent } from 'obsidian';
import type TriliumSyncPlugin from './main';
import type { TriliumSyncSettings, SyncFolderMapping } from './sync/types';

export type { TriliumSyncSettings } from './sync/types';
export { DEFAULT_SETTINGS } from './sync/types';

/** 设置面板 */
export class SettingsTab extends PluginSettingTab {
  private plugin: TriliumSyncPlugin;

  constructor(app: App, plugin: TriliumSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ---- 1. 连接配置 ----
    containerEl.createEl('h2', { text: '连接配置' });

    new Setting(containerEl)
      .setName('Trilium 地址')
      .setDesc('例如 https://note.laozhang.org 或 http://74.48.204.221:8080')
      .addText(text => text
        .setPlaceholder('https://')
        .setValue(this.plugin.settings.triliumUrl)
        .onChange(async (val) => {
          // 校验 URL 格式
          if (val && !val.match(/^https?:\/\/.+/)) {
            new Notice('地址必须以 http:// 或 https:// 开头');
            return;
          }
          this.plugin.settings.triliumUrl = val;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('ETAPI Token')
      .setDesc('在 Trilium 设置 → ETAPI 中生成')
      .addText(text => {
        text.inputEl.type = 'password'; // 隐藏 Token，防止屏幕共享/截图泄露
        text
          .setPlaceholder('token')
          .setValue(this.plugin.settings.etapiToken)
          .onChange(async (val) => {
            this.plugin.settings.etapiToken = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('测试连接')
      .addButton(btn => btn
        .setButtonText('测试连接')
        .onClick(() => this.testConnection()));

    containerEl.createEl('hr');

    // ---- 2. 自动同步 ----
    containerEl.createEl('h2', { text: '自动同步' });

    new Setting(containerEl)
      .setName('启用自动同步')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSyncEnabled)
        .onChange(async (val) => {
          this.plugin.settings.autoSyncEnabled = val;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('同步间隔（秒）')
      .setDesc('最低 30 秒，最高 3600 秒（1小时）')
      .addText(text => text
        .setPlaceholder('60')
        .setValue(String(this.plugin.settings.syncIntervalSeconds))
        .onChange(async (val) => {
          const n = Math.max(30, Math.min(3600, parseInt(val) || 60));
          this.plugin.settings.syncIntervalSeconds = n;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('hr');

    // ---- 3. 同步目录 ----
    const headerRow = containerEl.createDiv({ cls: 'trilium-sync-section-header' });
    headerRow.createEl('h2', { text: '同步目录' });

    const btnGroup = headerRow.createDiv({ cls: 'trilium-sync-btn-group' });

    // 强制刷新 Obsidian 目录树
    const obsidianRefreshBtn = btnGroup.createEl('button', { cls: 'trilium-sync-refresh-btn' });
    obsidianRefreshBtn.setText('🔃 强制刷新 Obsidian 目录树');
    obsidianRefreshBtn.title = '强制刷新 Obsidian 本地目录缓存';
    obsidianRefreshBtn.addEventListener('click', () => {
      const result = this.plugin.refreshObsidianFolderCache();
      new Notice(`Obsidian 目录已刷新，共 ${result.length} 个目录`);
    });

    // 强制刷新 Trilium 目录树
    const triliumRefreshBtn = btnGroup.createEl('button', { cls: 'trilium-sync-refresh-btn' });
    triliumRefreshBtn.setText('🔃 强制刷新 Trilium 目录树');
    triliumRefreshBtn.title = '强制重新从 Trilium 服务器拉取目录树';
    triliumRefreshBtn.addEventListener('click', async () => {
      triliumRefreshBtn.setText('刷新中…');
      triliumRefreshBtn.disabled = true;
      try {
        await this.plugin.refreshTriliumTreeCache();
      } catch (e) {
        new Notice('刷新 Trilium 目录树失败');
      } finally {
        triliumRefreshBtn.setText('🔃 强制刷新 Trilium 目录树');
        triliumRefreshBtn.disabled = false;
      }
    });

    const listContainer = containerEl.createDiv({ cls: 'trilium-sync-mapping-list' });
    this.renderMappings(listContainer);

    new Setting(containerEl)
      .addButton(btn => btn
        .setButtonText('+ 添加同步目录')
        .setCta()
        .onClick(async () => {
          this.plugin.settings.syncFolders.push({ obsidianPath: '', triliumPath: '' });
          await this.plugin.saveSettings();
          this.display();
        }));

    containerEl.createEl('hr');

    // ---- 4. 保存 ----
    new Setting(containerEl)
      .addButton(btn => btn
        .setButtonText('保存配置')
        .setCta()
        .onClick(async () => {
          await this.plugin.saveSettings();
          new Notice('配置已保存 ✓');
        }));
  }

  private renderMappings(container: HTMLElement) {
    container.empty();
    const mappings = this.plugin.settings.syncFolders;

    if (mappings.length === 0) {
      container.createEl('p', { text: '（未添加任何同步目录）', cls: 'trilium-sync-empty' });
      return;
    }

    mappings.forEach((mapping, idx) => {
      this.renderMappingRow(container, mapping, idx);
    });
  }

  private renderMappingRow(container: HTMLElement, mapping: SyncFolderMapping, idx: number) {
    const row = container.createDiv({ cls: 'trilium-sync-mapping-row' });

    // Obsidian 目录输入框 + 按钮
    const obsidianCol = row.createDiv({ cls: 'trilium-sync-mapping-col' });
    obsidianCol.createEl('label', { text: 'Obsidian 目录', cls: 'trilium-sync-col-label' });

    const obsidianInputRow = obsidianCol.createDiv({ cls: 'trilium-sync-input-row' });
    const obsidianInput = new TextComponent(obsidianInputRow);
    obsidianInput
      .setPlaceholder('选择目录')
      .setValue(mapping.obsidianPath)
      .onChange(value => {
        const item = this.plugin.settings.syncFolders[idx];
        if (item) item.obsidianPath = value;
        this.plugin.saveSettings();
      });

    const obsidianBtn = obsidianInputRow.createEl('button', { cls: 'trilium-sync-icon-btn', text: '📁' });
    obsidianBtn.onclick = (e) => {
      e.stopPropagation();
      this.showObsidianFolderPopup(obsidianBtn, mapping.obsidianPath, (path) => {
        const item = this.plugin.settings.syncFolders[idx];
        if (item) item.obsidianPath = path;
        this.plugin.saveSettings();
        obsidianInput.setValue(path);
      });
    };

    // 箭头
    row.createEl('span', { text: '→', cls: 'trilium-sync-arrow' });

    // Trilium 目录输入框 + 按钮
    const triliumCol = row.createDiv({ cls: 'trilium-sync-mapping-col' });
    triliumCol.createEl('label', { text: 'Trilium 目录', cls: 'trilium-sync-col-label' });

    const triliumInputRow = triliumCol.createDiv({ cls: 'trilium-sync-input-row' });
    const triliumInput = new TextComponent(triliumInputRow);
    triliumInput
      .setPlaceholder('选择目录')
      .setValue(mapping.triliumPath)
      .onChange(value => {
        const item = this.plugin.settings.syncFolders[idx];
        if (item) item.triliumPath = value;
        this.plugin.saveSettings();
      });

    const triliumBtn = triliumInputRow.createEl('button', { cls: 'trilium-sync-icon-btn', text: '📁' });
    triliumBtn.onclick = (e) => {
      e.stopPropagation();
      this.showTriliumFolderPopup(triliumBtn, mapping.triliumPath, (path) => {
        const item = this.plugin.settings.syncFolders[idx];
        if (item) item.triliumPath = path;
        this.plugin.saveSettings();
        triliumInput.setValue(path);
      });
    };

    // 删除按钮
    const delBtn = row.createEl('button', { cls: 'trilium-sync-delete-btn' });
    delBtn.setText('×');
    delBtn.title = '删除此映射';
    delBtn.addEventListener('click', () => {
      this.plugin.settings.syncFolders.splice(idx, 1);
      this.plugin.saveSettings();
      this.display();
    });
  }

  // ---- Obsidian 目录树弹出菜单 ----

  private showObsidianFolderPopup(
    anchorEl: HTMLElement,
    selectedPath: string,
    onSelect: (path: string) => void
  ): void {
    // 关闭已存在的弹出菜单
    const existing = document.querySelector('.trilium-sync-tree-popup');
    if (existing) existing.remove();

    // 创建弹出容器
    const popup = document.createElement('div');
    popup.className = 'trilium-sync-tree-popup';
    popup.style.cssText = `
      position: absolute;
      z-index: 1000;
      background: var(--background-secondary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      max-height: 300px;
      overflow-y: auto;
      min-width: 200px;
      padding: 8px 0;
    `;
    document.body.appendChild(popup);

    const rect = anchorEl.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${rect.left}px`;

    const folders = this.plugin.settings.cachedObsidianFolders || [];

    // 构建目录树
    const childrenMap = new Map<string, typeof folders>();
    for (const folder of folders) {
      const lastSlash = folder.path.lastIndexOf('/');
      const parentPath = lastSlash > 0 ? folder.path.substring(0, lastSlash) : '';
      if (!childrenMap.has(parentPath)) {
        childrenMap.set(parentPath, []);
      }
      childrenMap.get(parentPath)!.push(folder);
    }

    const rootFolders = childrenMap.get('') || [];

    const renderItem = (folder: typeof folders[0], level: number): HTMLElement => {
      const item = document.createElement('div');
      const hasChildren = childrenMap.has(folder.path);
      const indent = level * 16;
      const isSelected = folder.path === selectedPath;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'expand-icon';
      iconSpan.style.cssText = 'width: 16px; display: inline-block; font-size: 10px;';
      iconSpan.textContent = hasChildren ? '▶ ' : '';

      const contentDiv = document.createElement('div');
      contentDiv.style.cssText = `display: flex; align-items: center; padding: 4px 8px; cursor: pointer; ${isSelected ? 'background: var(--interactive-accent); color: white;' : ''}`;
      const indentSpan = document.createElement('span');
      indentSpan.style.width = `${indent}px`;
      indentSpan.style.display = 'inline-block';
      contentDiv.appendChild(indentSpan);
      contentDiv.appendChild(iconSpan);
      contentDiv.appendChild(document.createTextNode(folder.label));
      item.appendChild(contentDiv);

      if (hasChildren) {
        contentDiv.onclick = (e) => {
          e.stopPropagation();
          const existingChild = item.querySelector('.child-container');
          if (existingChild) {
            existingChild.remove();
            iconSpan.textContent = '▶ ';
          } else {
            iconSpan.textContent = '▼ ';
            const childContainer = document.createElement('div');
            childContainer.className = 'child-container';
            childContainer.style.marginLeft = '8px';
            const children = childrenMap.get(folder.path) || [];
            for (const child of children.sort((a, b) => a.label.localeCompare(b.label))) {
              childContainer.appendChild(renderItem(child, level + 1));
            }
            item.appendChild(childContainer);
          }
        };
      } else {
        contentDiv.onclick = (e) => {
          e.stopPropagation();
          onSelect(folder.path);
          popup.remove();
        };
      }

      contentDiv.ondblclick = (e) => {
        e.stopPropagation();
        onSelect(folder.path);
        popup.remove();
      };

      return item;
    };

    popup.replaceChildren();
    if (rootFolders.length === 0) {
      const emptyMsg = popup.createDiv();
      emptyMsg.style.padding = '8px';
      emptyMsg.style.color = 'var(--text-muted)';
      emptyMsg.textContent = '无目录（请先刷新 Obsidian 目录树）';
    } else {
      for (const folder of rootFolders.sort((a, b) => a.label.localeCompare(b.label))) {
        popup.appendChild(renderItem(folder, 0));
      }
    }

    const closeHandler = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node) && e.target !== anchorEl) {
        popup.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  // ---- Trilium 目录树弹出菜单 ----

  private showTriliumFolderPopup(
    anchorEl: HTMLElement,
    selectedPath: string,
    onSelect: (path: string) => void
  ): void {
    // 关闭已存在的弹出菜单
    const existing = document.querySelector('.trilium-sync-tree-popup');
    if (existing) existing.remove();

    // 创建弹出容器
    const popup = document.createElement('div');
    popup.className = 'trilium-sync-tree-popup';
    popup.style.cssText = `
      position: absolute;
      z-index: 1000;
      background: var(--background-secondary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      max-height: 300px;
      overflow-y: auto;
      min-width: 200px;
      padding: 8px 0;
    `;
    document.body.appendChild(popup);

    const rect = anchorEl.getBoundingClientRect();
    popup.style.top = `${rect.bottom + 4}px`;
    popup.style.left = `${rect.left}px`;

    const folders = this.plugin.settings.cachedTriliumFolders || [];

    // 从扁平路径构建父子关系
    const childrenMap = new Map<string, typeof folders>();
    for (const folder of folders) {
      const lastSlash = folder.path.lastIndexOf('/');
      const parentPath = lastSlash > 0 ? folder.path.substring(0, lastSlash) : '';
      if (!childrenMap.has(parentPath)) {
        childrenMap.set(parentPath, []);
      }
      childrenMap.get(parentPath)!.push(folder);
    }

    const rootFolders = childrenMap.get('') || [];

    const renderItem = (folder: typeof folders[0], level: number): HTMLElement => {
      const item = document.createElement('div');
      const hasChildren = childrenMap.has(folder.path);
      const indent = level * 16;
      const isSelected = folder.path === selectedPath;
      const label = folder.path.split('/').pop() || folder.path;

      const iconSpan = document.createElement('span');
      iconSpan.className = 'expand-icon';
      iconSpan.style.cssText = 'width: 16px; display: inline-block; font-size: 10px;';
      iconSpan.textContent = hasChildren ? '▶ ' : '';

      const contentDiv = document.createElement('div');
      contentDiv.style.cssText = `display: flex; align-items: center; padding: 4px 8px; cursor: pointer; ${isSelected ? 'background: var(--interactive-accent); color: white;' : ''}`;
      const indentSpan = document.createElement('span');
      indentSpan.style.width = `${indent}px`;
      indentSpan.style.display = 'inline-block';
      contentDiv.appendChild(indentSpan);
      contentDiv.appendChild(iconSpan);
      contentDiv.appendChild(document.createTextNode(label));
      item.appendChild(contentDiv);

      if (hasChildren) {
        contentDiv.onclick = (e) => {
          e.stopPropagation();
          const existingChild = item.querySelector('.child-container');
          if (existingChild) {
            existingChild.remove();
            iconSpan.textContent = '▶ ';
          } else {
            iconSpan.textContent = '▼ ';
            const childContainer = document.createElement('div');
            childContainer.className = 'child-container';
            childContainer.style.marginLeft = '8px';
            const children = childrenMap.get(folder.path) || [];
            for (const child of children.sort((a, b) => a.path.localeCompare(b.path))) {
              childContainer.appendChild(renderItem(child, level + 1));
            }
            item.appendChild(childContainer);
          }
        };
      } else {
        contentDiv.onclick = (e) => {
          e.stopPropagation();
          onSelect(folder.path);
          popup.remove();
        };
      }

      contentDiv.ondblclick = (e) => {
        e.stopPropagation();
        onSelect(folder.path);
        popup.remove();
      };

      return item;
    };

    popup.replaceChildren();
    if (rootFolders.length === 0) {
      const emptyMsg = popup.createDiv();
      emptyMsg.style.padding = '8px';
      emptyMsg.style.color = 'var(--text-muted)';
      emptyMsg.textContent = '无目录（请先刷新 Trilium 目录树）';
    } else {
      for (const folder of rootFolders.sort((a, b) => a.path.localeCompare(b.path))) {
        popup.appendChild(renderItem(folder, 0));
      }
    }

    const closeHandler = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node) && e.target !== anchorEl) {
        popup.remove();
        document.removeEventListener('click', closeHandler);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
  }

  private async testConnection(): Promise<void> {
    const { triliumUrl, etapiToken } = this.plugin.settings;
    if (!triliumUrl || !etapiToken) {
      new Notice('请先填写 Trilium 地址和 ETAPI Token');
      return;
    }

    new Notice('正在测试连接…');

    try {
      // 使用 plugin 缓存的 etapi 实例，而不是每次创建新的
      let etapi = this.plugin.getEtapi();
      if (!etapi) {
        // 如果 plugin 的 etapi 未初始化（理论上不会），则创建新的
        const { EtapiClient } = await import('./sync/etapi');
        etapi = new EtapiClient(triliumUrl, etapiToken);
      }
      const info = await etapi.getAppInfo();
      new Notice(`连接成功 ✓ (Trilium ${info.appVersion})`);
    } catch (e: unknown) {
      let msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('Network request failed')) {
        msg = '网络连接失败，请检查地址是否正确';
      } else if (msg.includes('401') || msg.includes('Unauthorized')) {
        msg = '认证失败：ETAPI Token 无效';
      } else if (msg.includes('403') || msg.includes('Forbidden')) {
        msg = '权限不足：请确认 Token 有 ETAPI 访问权限';
      } else if (msg.includes('404') || msg.includes('Not Found')) {
        msg = 'ETAPI 端点不存在：确认地址是否正确';
      } else if (msg.includes('timeout') || msg.includes('Timeout') || msg.includes('ERR_CONNECTION')) {
        msg = '连接超时，请检查网络或 Trilium 服务是否可用';
      }
      new Notice(`连接失败: ${msg}`);
    }
  }
}
