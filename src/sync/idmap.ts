import { App } from 'obsidian';
import type { IdMap, IdMapEntry } from './types';

const ID_MAP_FILE = 'id-map.json';
export const PLUGIN_DIR = '.obsidian/plugins/trilium-sync';

/**
 * IdMapManager — 维护 Obsidian 文件路径 → Trilium noteId 的映射表
 *
 * 文件结构（id-map.json）：
 * {
 *   "/path/to/file.md": { "noteId": "xxx", "title": "yyy", "syncedAt": "ISO" },
 *   ...
 * }
 *
 * 职责：
 * 1. 从磁盘加载 / 持久化 id-map.json
 * 2. 根据 Obsidian 路径查 noteId（get）
 * 3. 记录新建映射（set）
 * 4. 删除映射（remove）
 * 5. 重命名时更新路径（rename）
 *
 * 性能优化：
 * - set/remove 只修改内存并标记 dirty，不立即写磁盘
 * - 调用 saveIfDirty() 才会实际写入（syncNow 结束后调用）
 */
export class IdMapManager {
  private app: App;
  private map: IdMap = {};
  private loaded = false;
  private dirty = false;  // 脏标记：有未保存的修改

  constructor(app: App) {
    this.app = app;
  }

  /** 从磁盘加载 id-map.json（位于 .trilium-sync/ 插件子目录） */
  async load(): Promise<void> {
    try {
      const filePath = this.getPluginFilePath(ID_MAP_FILE);
      const data = await this.app.vault.adapter.read(filePath);
      this.map = JSON.parse(data);
    } catch {
      // 文件不存在或解析失败，用空 map
      this.map = {};
    }
    this.loaded = true;
    this.dirty = false;
  }

  /** 持久化到磁盘 */
  async save(): Promise<void> {
    const dir = this.getPluginDir();
    if (!await this.app.vault.adapter.exists(dir)) {
      await this.app.vault.adapter.mkdir(dir);
    }
    await this.app.vault.adapter.write(
      `${dir}/${ID_MAP_FILE}`,
      JSON.stringify(this.map, null, 2),
    );
    this.dirty = false;
  }

  /** 如果有未保存的修改则保存（syncNow 结束后调用） */
  async saveIfDirty(): Promise<void> {
    if (this.dirty) {
      await this.save();
    }
  }

  /** 获取插件目录路径 */
  private getPluginDir(): string {
    return PLUGIN_DIR;
  }

  private getPluginFilePath(file: string): string {
    return `${this.getPluginDir()}/${file}`;
  }

  // ---- 对外 API ----

  /** 根据 Obsidian 文件路径查找 noteId */
  getNoteId(filePath: string): string | undefined {
    return this.map[filePath]?.noteId;
  }

  /** 根据 Obsidian 文件路径查找整条记录 */
  get(filePath: string): IdMapEntry | undefined {
    return this.map[filePath];
  }

  /** 记录一个新创建的同步映射（只修改内存，不立即写磁盘） */
  async set(filePath: string, entry: IdMapEntry): Promise<void> {
    this.map[filePath] = entry;
    this.dirty = true;
    // 不再每次调用 save()，由调用方在 syncNow 结束后调用 saveIfDirty()
  }

  /** 删除某个路径的映射（只修改内存，不立即写磁盘） */
  async remove(filePath: string): Promise<void> {
    delete this.map[filePath];
    this.dirty = true;
    // 不再每次调用 save()，由调用方在 syncNow 结束后调用 saveIfDirty()
  }

  /**
   * 重命名文件时更新映射
   * 旧路径 → 新路径，noteId 不变
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    if (!this.map[oldPath]) return;  // 没有记录，不处理
    this.map[newPath] = { ...this.map[oldPath] };
    delete this.map[oldPath];
    this.dirty = true;
  }

  /** 获取所有路径（用于遍历检查哪些文件已同步） */
  allPaths(): string[] {
    return Object.keys(this.map);
  }

  /** 获取所有记录（深拷贝，防止调用方修改绕过 dirty 标记） */
  all(): IdMap {
    const result: IdMap = {};
    for (const [key, entry] of Object.entries(this.map)) {
      if (entry) {
        result[key] = { noteId: entry.noteId, title: entry.title, syncedAt: entry.syncedAt };
      }
    }
    return result;
  }

  /** 强制刷新（重新加载） */
  async reload(): Promise<void> {
    this.loaded = false;
    await this.load();
  }
}
