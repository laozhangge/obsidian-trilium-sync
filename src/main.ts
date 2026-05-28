import { App, Plugin, Notice, TFile } from 'obsidian';
import { SyncManager } from './sync/manager';
import { EtapiClient } from './sync/etapi';
import { SettingsTab, TriliumSyncSettings, DEFAULT_SETTINGS } from './settings';

export type { TriliumSyncSettings };
export { DEFAULT_SETTINGS };

export default class TriliumSyncPlugin extends Plugin {
  public settings: TriliumSyncSettings = DEFAULT_SETTINGS;
  private syncManager: SyncManager | null = null;
  private etapi: EtapiClient | null = null;
  private modifyDebounceTimer: number | null = null;
  private dirtyFiles: Set<string> = new Set();

  async onload() {
    await this.loadSettings();

    // 每次启动都更新 startTime，确保只同步本次启动后的新文件/变更
    this.settings.startTime = Date.now();
    await this.saveSettings();

    // 初始化 etapi 实例
    this.updateEtapi();

    // 初始化 Obsidian 目录树缓存（如果为空则扫描）
    this.getObsidianFolderTree(false);

    // 启动时后台静默预加载 Trilium 目录缓存（缓存有效则零操作，失败静默忽略）
    if (this.settings.triliumUrl && this.settings.etapiToken) {
      this.preloadTriliumTreeCache().catch(() => {/* 静默失败 */});
    }

    this.addSettingTab(new SettingsTab(this.app, this));

    this.syncManager = new SyncManager(this.app, this.settings);
    this.syncManager.updateSettings(this.settings);

    // 启动时检查上次未完成的同步（Obsidian 强制关闭导致的中断）
    if (this.settings.pendingSyncFiles.length > 0) {
      const pendingFiles = [...this.settings.pendingSyncFiles];
      this.settings.pendingSyncFiles = [];
      await this.saveSettings();
      // 延迟执行，等 init 完成
      setTimeout(async () => {
        if (this.syncManager) {
          console.log(`[trilium-sync] 补同步上次中断的 ${pendingFiles.length} 个文件`);
          await this.syncManager.syncSpecificFiles(pendingFiles);
        }
      }, 2000);
    }

    // 监听文件修改事件，记录 dirty 文件并持久化，防抖后增量同步
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && file.extension === 'md') {
          this.dirtyFiles.add(file.path);
          // 立即持久化 pending list，防止 Obsidian 强制关闭时丢失
          this.persistPendingFiles();
          this.scheduleSyncAfterModify();
        }
      })
    );

    // 监听文件重命名事件：更新 idMap 映射，防止重命名后产生重复笔记
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          if (this.syncManager) {
            this.syncManager.renameFileMapping(oldPath, file.path);
          }
        }
      })
    );

    // 手动同步按钮（Ribbon 图标）
    this.addRibbonIcon('sync', '手动同步', async () => {
      if (this.syncManager) {
        await this.syncManager.syncNow();
      }
    });

    // 状态栏文字
    this.addStatusBarItem().setText('Trilium Sync');
  }

  /** 更新 etapi 实例（settings 改变时调用） */
  private updateEtapi(): void {
    if (this.settings.triliumUrl && this.settings.etapiToken) {
      this.etapi = new EtapiClient(this.settings.triliumUrl, this.settings.etapiToken);
    } else {
      this.etapi = null;
    }
  }

  /** 获取 etapi 实例（供 settings.ts 的 testConnection 使用） */
  public getEtapi(): EtapiClient | null {
    return this.etapi;
  }

  /** 获取 Obsidian 目录树（优先从缓存读取） */
  getObsidianFolderTree(forceRefresh: boolean): { path: string; label: string }[] {
    // 强制刷新时清空缓存
    if (forceRefresh) {
      this.settings.cachedObsidianFolders = [];
      this.saveData(this.settings); // 同步写入，getObsidianFolderTree 非 async
    }

    // 优先从缓存读取
    if (this.settings.cachedObsidianFolders.length > 0) {
      return this.settings.cachedObsidianFolders;
    }

    // 缓存为空，从 vault 实时构建
    const folderSet: Set<string> = new Set();
    const files = this.app.vault.getMarkdownFiles();

    for (const file of files) {
      const path = file.path;
      const lastSlash = path.lastIndexOf('/');
      if (lastSlash <= 0) continue;

      const dirPath = path.substring(0, lastSlash);
      const parts = dirPath.split('/');

      // 收集所有层级的父目录
      for (let i = 1; i <= parts.length; i++) {
        const ancestorPath = parts.slice(0, i).join('/');
        folderSet.add(ancestorPath);
      }
    }

    const sortedFolders = Array.from(folderSet).sort();
    const result = sortedFolders.map(dirPath => {
      const parts = dirPath.split('/');
      const label = parts[parts.length - 1] || dirPath;
      return { path: dirPath, label };
    });

    // 只有扫描到有效目录才更新缓存
    if (result.length > 0) {
      this.settings.cachedObsidianFolders = result;
      this.saveData(this.settings); // 同步写入，getObsidianFolderTree 非 async
    }

    return result;
  }

  /** 刷新 Obsidian 目录树缓存 */
  refreshObsidianFolderCache(): { path: string; label: string }[] {
    return this.getObsidianFolderTree(true);
  }

  /** 获取 Trilium 目录树缓存（供设置界面使用） */
  getCachedTriliumFolders(): { path: string; noteId: string }[] {
    return this.settings.cachedTriliumFolders;
  }

  /** 供设置 tab 调用（强制刷新 - 全量遍历 + 并发优化） */
  async refreshTriliumTreeCache(): Promise<void> {
    if (!this.settings.triliumUrl || !this.settings.etapiToken) {
      new Notice('请先配置 Trilium 连接');
      return;
    }

    try {
      // 使用缓存的 etapi 实例，而不是每次创建新的
      if (!this.etapi) {
        this.updateEtapi();
      }

      // 全量遍历（使用并发优化）
      console.log('[main] refreshTriliumTreeCache: 全量遍历');
      const folders = await this.etapi!.getFolderTree(10 * 60 * 1000, 5);
      this.settings.cachedTriliumFolders = folders;
      await this.saveSettings();
      new Notice(`Trilium 目录树已刷新，共 ${folders.length} 个目录`);
    } catch (e) {
      console.error('[trilium-sync] 刷新 Trilium 目录树失败:', e);
      new Notice('刷新 Trilium 目录树失败');
      throw e;
    }
  }

  /** 增量刷新 Trilium 目录缓存（自动刷新用，轻量级） */
  async incrementalRefreshTriliumTreeCache(): Promise<boolean> {
    if (!this.etapi || !this.settings.cachedTriliumFolders || this.settings.cachedTriliumFolders.length === 0) {
      return false; // 无法增量刷新
    }

    try {
      console.log('[main] incrementalRefreshTriliumTreeCache: 增量更新');
      const cachedFolders = this.settings.cachedTriliumFolders;
      const cachedNoteIds = new Set(cachedFolders.map(f => f.noteId));
      let newFolders = [...cachedFolders];
      let hasChanges = false;

      // 从根节点开始，递归检查每个节点的子节点变化（限制最大深度防止栈溢出）
      const MAX_DEPTH = 10;
      const checkNode = async (noteId: string, path: string, depth: number): Promise<void> => {
        if (depth >= MAX_DEPTH) {
          console.warn(`[main] 增量更新: 达到最大递归深度 ${MAX_DEPTH}，停止深入 "${path}"`);
          return;
        }
        try {
          const note = await this.etapi!.getNote(noteId);
          const currentChildIds = (note.childNoteIds ?? []).filter((id: string) => id !== '_hidden');

          // 从缓存中提取该节点的子节点
          const cachedChildren = cachedFolders.filter(f => {
            const lastSlash = f.path.lastIndexOf('/');
            const parentPath = lastSlash > 0 ? f.path.substring(0, lastSlash) : '';
            return parentPath === path;
          });
          const cachedChildNoteIds = new Set(cachedChildren.map(f => f.noteId));

          // 找出新增和删除的子节点
          const addedChildIds = currentChildIds.filter((id: string) => !cachedChildNoteIds.has(id));
          const removedChildIds = Array.from(cachedChildNoteIds).filter(id => !currentChildIds.includes(id));

          if (addedChildIds.length > 0 || removedChildIds.length > 0) {
            hasChanges = true;
            console.log(`[main] 增量更新: 节点 "${path}" 新增 ${addedChildIds.length} 个, 删除 ${removedChildIds.length} 个子节点`);

            // 删除已不存在的子树
            if (removedChildIds.length > 0) {
              const removedPaths = cachedFolders
                .filter(f => removedChildIds.includes(f.noteId))
                .map(f => f.path);

              newFolders = newFolders.filter(f => {
                return !removedPaths.some(prefix =>
                  f.path === prefix || f.path.startsWith(prefix + '/')
                );
              });
            }

            // 遍历新增的子树
            for (const childId of addedChildIds) {
              try {
                const childNote = await this.etapi!.getNote(childId);
                const childPath = path ? `${path}/${childNote.title}` : childNote.title;
                console.log(`[main] 增量更新: 遍历新增子树 "${childPath}" (${childId})`);

                const subFolders = await this.etapi!.getSubTree(childId, childPath, 5 * 60 * 1000, 5);
                newFolders.push(...subFolders);
              } catch (e) {
                console.warn(`[main] 增量更新: 遍历新增子树 ${childId} 失败`, e);
              }
            }
          }

          // 递归检查现有子节点
          for (const childId of currentChildIds) {
            if (cachedChildNoteIds.has(childId)) {
              const childSegment = cachedChildren.find(f => f.noteId === childId)?.path.split('/').pop();
              const childPath = childSegment ? (path ? `${path}/${childSegment}` : childSegment) : undefined;
              if (childPath) {
                await checkNode(childId, childPath, depth + 1);
              }
            }
          }
        } catch (e) {
          console.warn(`[main] 增量更新: 检查节点 ${noteId} 失败`, e);
        }
      };

      // 从根节点开始检查
      const root = await this.etapi.getRoot();
      const rootChildIds = (root.childNoteIds ?? []).filter((id: string) => id !== '_hidden');

      for (const childId of rootChildIds) {
        const topLevelFolder = cachedFolders.find(f => f.noteId === childId);
        if (topLevelFolder) {
          await checkNode(childId, topLevelFolder.path, 0);
        } else {
          // 顶层节点是新增的
          hasChanges = true;
          try {
            const childNote = await this.etapi.getNote(childId);
            const childPath = childNote.title;
            console.log(`[main] 增量更新: 遍历新增顶层子树 "${childPath}" (${childId})`);

            const subFolders = await this.etapi.getSubTree(childId, childPath, 5 * 60 * 1000, 5);
            newFolders.push(...subFolders);
          } catch (e) {
            console.warn(`[main] 增量更新: 遍历新增顶层子树 ${childId} 失败`, e);
          }
        }
      }

      if (!hasChanges) {
        console.log('[main] 增量更新: 无变化');
        return false; // 无变化
      }

      // 排序并更新缓存
      newFolders.sort((a, b) => a.path.localeCompare(b.path));
      this.settings.cachedTriliumFolders = newFolders;
      await this.saveSettings();

      console.log(`[main] 增量更新完成，共 ${newFolders.length} 个目录`);
      return true;
    } catch (e) {
      console.warn('[main] 增量更新失败:', e);
      return false;
    }
  }

  /** 启动时静默预加载 Trilium 目录缓存（不阻塞、不报错） */
  private async preloadTriliumTreeCache(): Promise<void> {
    // 已有缓存时不重复加载（依赖 TTL 自然过期）
    if (this.settings.cachedTriliumFolders.length > 0) {
      return;
    }
    // 缓存为空时触发首次加载
    await this.refreshTriliumTreeCache();
  }

  /** 文件修改后防抖触发增量同步 */
  private scheduleSyncAfterModify(): void {
    if (this.modifyDebounceTimer !== null) {
      window.clearTimeout(this.modifyDebounceTimer);
    }
    this.modifyDebounceTimer = window.setTimeout(async () => {
      this.modifyDebounceTimer = null;
      if (this.syncManager && this.dirtyFiles.size > 0) {
        const files = Array.from(this.dirtyFiles);
        this.dirtyFiles.clear();
        console.log(`[trilium-sync] 文件修改触发增量同步，${files.length} 个文件`);
        try {
          await this.syncManager.syncSpecificFiles(files);
          // 同步成功后清空 pending list
          this.settings.pendingSyncFiles = [];
          await this.saveSettings();
        } catch (e) {
          console.error('[trilium-sync] 增量同步异常:', e);
        }
      }
    }, 3000);
  }

  /** 持久化 dirty files 到 settings（防止 Obsidian 强制关闭丢失） */
  private persistPendingFiles(): void {
    this.settings.pendingSyncFiles = Array.from(this.dirtyFiles);
    this.saveData(this.settings);
  }

  async onunload() {
    // 1. 清理修改防抖定时器
    if (this.modifyDebounceTimer !== null) {
      window.clearTimeout(this.modifyDebounceTimer);
      this.modifyDebounceTimer = null;
    }

    // 2. 强制保存所有打开的编辑器
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as any;
      if (view && typeof view.save === 'function') {
        view.save();
      }
    });

    // 3. 等待写盘
    await new Promise(resolve => setTimeout(resolve, 500));

    // 4. 增量同步剩余 dirty files（轻量，只同步修改过的文件）
    if (this.syncManager && this.dirtyFiles.size > 0) {
      const files = Array.from(this.dirtyFiles);
      this.dirtyFiles.clear();
      await this.syncManager.syncSpecificFiles(files);
    }

    // 5. 兜底：全量同步一次 + 停止自动同步
    if (this.syncManager) {
      await this.syncManager.syncNow();
      this.syncManager.stopAutoSync();
    }
  }

  async loadSettings() {
    const saved = await this.loadData();
    // 深拷贝数组字段，避免 Object.assign 浅拷贝导致 DEFAULT_SETTINGS 数组被污染
    this.settings = {
      ...(Object.assign({}, DEFAULT_SETTINGS, saved)),
      syncFolders: Array.isArray(saved?.syncFolders) ? [...saved.syncFolders] : [...DEFAULT_SETTINGS.syncFolders],
      cachedObsidianFolders: Array.isArray(saved?.cachedObsidianFolders) ? [...saved.cachedObsidianFolders] : [],
      cachedTriliumFolders: Array.isArray(saved?.cachedTriliumFolders) ? [...saved.cachedTriliumFolders] : [],
      pendingSyncFiles: Array.isArray(saved?.pendingSyncFiles) ? [...saved.pendingSyncFiles] : [],
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.syncManager?.updateSettings(this.settings);
  }
}
