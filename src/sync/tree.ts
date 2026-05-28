import { App } from 'obsidian';
import { EtapiClient } from './etapi';
import { PLUGIN_DIR } from './idmap';
import type { TreeNode } from './types';

const TREE_CACHE_FILE = 'tree-cache.json';
const PLUGIN_ID = 'trilium-sync';

interface TreeCacheData {
  cachedAt: number;
  /** path 路径（相对于 root）→ noteId */
  pathMap: Record<string, string>;
  /** root 的直接子节点 noteId 列表（用于增量更新判断） */
  rootChildNoteIds?: string[];
  /** 各子树的根节点 noteId 列表（用于增量更新） */
  subTreeRoots?: { path: string; noteId: string }[];
}

interface CachedFolder {
  path: string;
  noteId: string;
}

interface SettingsData {
  cachedTriliumFolders?: CachedFolder[];
  syncFolders?: { obsidianPath: string; triliumPath: string }[];
}

/**
 * TreeCacheManager — 维护 Obsidian 目录路径到 Trilium noteId 的映射缓存
 *
 * 工作方式：
 * 1. 从 Trilium root 向下递归，抓取目录结构（深度 5）
 * 2. 构建 path → noteId 的 Map（path = 相对路径，如 "01-每日一志/子目录"）
   * 3. 持久化到 .obsidian/plugins/trilium-sync/tree-cache.json
 * 4. resolveParentNoteId(filePath) 用逐级向上查的方式找父目录对应的 noteId
 */
export class TreeCacheManager {
  private app: App;
  private etapi: EtapiClient;
  private cache: TreeCacheData = { cachedAt: 0, pathMap: {} };
  private loaded = false;
  /** 正在刷新的 Promise，多个请求共享，避免并发刷多次 */
  private refreshPromise: Promise<Record<string, string>> | null = null;
  /** 从 data.json 加载的 cachedTriliumFolders，用于快速查找 mapping 根 noteId */
  private cachedFolders: CachedFolder[] = [];

  constructor(app: App, etapi: EtapiClient) {
    this.app = app;
    this.etapi = etapi;
  }

  // ---- 从 data.json 加载 settings（含 cachedTriliumFolders） ----

  /**
   * 从插件的 data.json 加载 cachedTriliumFolders，
   * 这样 refreshCore() 就能直接查到 mapping 根的 noteId，不用从 root 遍历全量树。
   * 注意：data.json 在插件目录 .obsidian/plugins/trilium-sync/，不在子目录里。
   */
  async loadCachedFolders(): Promise<void> {
    try {
      // data.json 在插件目录 .obsidian/plugins/trilium-sync/ 下
      const raw = await this.app.vault.adapter.read(this.getPluginFilePath('data.json'));
      const data: SettingsData = JSON.parse(raw);
      this.cachedFolders = data.cachedTriliumFolders ?? [];
      console.log(`[tree] loadCachedFolders 加载了 ${this.cachedFolders.length} 条目录缓存`);
    } catch {
      this.cachedFolders = [];
      console.warn('[tree] loadCachedFolders 失败，使用空列表');
    }
  }

  /**
   * 根据 triliumPath 从 cachedFolders 查出 noteId。
   * triliumPath 如 "老张的酷/01-每日一志/2026/2026-04"。
   * 由于 cachedFolders 里存的是相对路径（不含 root 标题），
   * 如 "01-每日一志/2026/2026-04"，所以需要自动剥离 root 前缀再匹配。
   */
  private async findNoteIdByPath(triliumPath: string): Promise<string | null> {
    // 先尝试直接匹配（triliumPath 可能已经是相对路径）
    let entry = this.cachedFolders.find(f => f.path === triliumPath);
    if (entry) return entry.noteId;

    // triliumPath 包含 root 标题，尝试剥离后匹配
    try {
      const root = await this.etapi.getRoot();
      const rootTitle = root.title;
      if (triliumPath.startsWith(rootTitle + '/')) {
        const relativePath = triliumPath.slice(rootTitle.length + 1);
        entry = this.cachedFolders.find(f => f.path === relativePath);
        if (entry) {
          console.log(`[tree] findNoteIdByPath: 剥离 root "${rootTitle}" 后匹配到 ${relativePath}`);
          return entry.noteId;
        }
      }
    } catch {
      // ignore
    }

    return null;
  }

  // ---- 缓存加载 / 保存 ----

  async load(): Promise<void> {
    try {
      const filePath = this.getPluginFilePath(TREE_CACHE_FILE);
      const data = await this.app.vault.adapter.read(filePath);
      this.cache = JSON.parse(data);
    } catch {
      this.cache = { cachedAt: 0, pathMap: {} };
    }
    this.loaded = true;
  }

  async save(): Promise<void> {
    const dir = this.getPluginDir();
    if (!await this.app.vault.adapter.exists(dir)) {
      await this.app.vault.adapter.mkdir(dir);
    }
    await this.app.vault.adapter.write(
      `${dir}/${TREE_CACHE_FILE}`,
      JSON.stringify(this.cache, null, 2),
    );
  }

  private getPluginDir(): string {
    return PLUGIN_DIR;
  }

  private getPluginFilePath(file: string): string {
    return `${this.getPluginDir()}/${file}`;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  /** 获取当前的 pathMap（供外部使用） */
  getPathMap(): Record<string, string> {
    return this.cache.pathMap;
  }

  /** 缓存是否过期（超过 10 分钟） */
  isExpired(): boolean {
    // 缓存为空（从未加载过）也算过期
    if (this.cache.cachedAt === 0) return true;
    return Date.now() - this.cache.cachedAt > 10 * 60 * 1000;
  }

  /** 需要刷新：未加载、过期、或 pathMap 为空（可能是旧缓存损坏） */
  needsRefresh(): boolean {
    return !this.loaded || this.isExpired() || Object.keys(this.cache.pathMap).length === 0;
  }

  /**
   * 确保缓存已加载。多个请求同时调用时会共享同一个刷新 Promise，
   * 避免启动时大量文件同时触发 N 次 getFolderTree。
   * 注意：此方法永远不会抛错，失败时也会 resolve，让调用链继续。
   */
  /**
   * 确保缓存已加载。多个请求同时调用时会共享同一个刷新 Promise，
   * 避免启动时大量文件同时触发 N 次 getFolderTree。
   * 注意：此方法永远不会抛错，失败时也会 resolve，让调用链继续。
   * @param triliumMappings 来自 settings.syncFolders 的 triliumPath 列表
   */
  async ensureLoaded(triliumMappings?: string[]): Promise<void> {
    if (!this.needsRefresh()) return;

    // 已有刷新在进行中，等它完成
    if (this.refreshPromise) {
      await this.refreshPromise;
      return;
    }

    // 发起刷新，共享 Promise
    this.refreshPromise = this.refreshCore(triliumMappings);
    await this.refreshPromise;
    this.refreshPromise = null;
  }

  // ---- 核心 API ----

  /**
   * 根据 Obsidian 文件路径，查找对应的 parent noteId
   * 例如 "01-每日一志/2026-04-30.md" → root 的某个子节点 noteId
   */
  async resolveParentNoteId(filePath: string): Promise<string> {
    // 空路径 → root
    if (!filePath) return 'root';

    // 去掉文件名，只要父目录路径
    const parentPath = filePath.split('/').slice(0, -1).join('/');
    console.log(`[tree] resolveParentNoteId: filePath=${filePath}, parentPath=${parentPath}`);

    // 空（文件直接在根目录）→ root
    if (!parentPath) return 'root';

    // 精确匹配
    if (this.cache.pathMap[parentPath]) {
      console.log(`[tree]   精确匹配: ${parentPath} → ${this.cache.pathMap[parentPath]}`);
      return this.cache.pathMap[parentPath];
    }

    // 逐级向上查找
    const parts = parentPath.split('/');
    let noteId = 'root';
    console.log(`[tree]   逐级查找, 共 ${parts.length} 级, pathMap 现有 ${Object.keys(this.cache.pathMap).length} 条`);

    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i];
      const fullPath = parts.slice(0, i + 1).join('/');

      if (this.cache.pathMap[fullPath]) {
        noteId = this.cache.pathMap[fullPath];
        console.log(`[tree]   找到[${i}]: ${fullPath} → ${noteId}`);
      } else {
        // 找不到，尝试在 Trilium 中查找（或创建）这个路径
        console.log(`[tree]   缺失[${i}]: ${fullPath}，尝试 findOrCreatePath`);
        const found = await this.findOrCreatePath(parts.slice(0, i + 1), noteId);
        if (found) {
          noteId = found;
          this.cache.pathMap[fullPath] = found;
          console.log(`[tree]   创建/找到: ${fullPath} → ${found}`);
        } else {
          // 仍然找不到，用当前的 noteId 凑合
          console.warn(`[tree]   找不到且创建失败，用 fallback: ${noteId}`);
          return noteId;
        }
      }
    }

    return noteId;
  }

  async refresh(triliumMappings?: string[]): Promise<Record<string, string>> {
    await this.ensureLoaded(triliumMappings);
    return this.cache.pathMap;
  }

  /**
   * 实际执行刷新。
   * - 首次：全量遍历
   * - 非首次：增量更新（只遍历变化的子树）
   * - 若传入了 triliumMappings，则只抓 mapping 相关的子树
   * 永远不抛错，失败时返回空 pathMap。
   */
  private async refreshCore(triliumMappings?: string[]): Promise<Record<string, string>> {
    try {
      const pathMap: Record<string, string> = {};
      const isFirstRefresh = this.cache.cachedAt === 0 || Object.keys(this.cache.pathMap).length === 0;

      if (triliumMappings && triliumMappings.length > 0) {
        // ---- 优化路径：只抓 mapping 相关的子树 ----
        console.log(`[tree] refreshCore: 使用优化模式，mappings=${JSON.stringify(triliumMappings)}`);

        for (const triliumPath of triliumMappings) {
          const rootNoteId = await this.findNoteIdByPath(triliumPath);
          if (!rootNoteId) {
            console.warn(`[tree] refreshCore: cachedFolders 中找不到 "${triliumPath}"，跳过`);
            continue;
          }
          console.log(`[tree] refreshCore: 从 "${triliumPath}" (noteId=${rootNoteId}) 开始 walk`);
          // 使用 getSubTree 增量获取子树
          const subFolders = await this.etapi.getSubTree(rootNoteId, triliumPath, 5 * 60 * 1000, 5);
          for (const folder of subFolders) {
            // 剥离前缀，存入 pathMap
            const storedPath = folder.path === triliumPath
              ? triliumPath
              : folder.path.startsWith(triliumPath + '/')
                ? folder.path.slice(triliumPath.length + 1)
                : folder.path;
            if (storedPath) {
              pathMap[storedPath] = folder.noteId;
            }
          }
        }
      } else if (isFirstRefresh) {
        // ---- 首次全量遍历 ----
        console.log('[tree] refreshCore: 首次刷新，全量遍历');
        const allFolders = await this.etapi.getFolderTree(10 * 60 * 1000, 5);

        // 获取 root 的子节点用于增量判断
        const root = await this.etapi.getRoot();
        const rootChildNoteIds = root.childNoteIds ?? [];

        for (const folder of allFolders) {
          pathMap[folder.path] = folder.noteId;
        }

        this.cache = {
          cachedAt: Date.now(),
          pathMap,
          rootChildNoteIds,
          subTreeRoots: allFolders.filter(f =>
            rootChildNoteIds.some(id => f.noteId === id)
          ),
        };
      } else {
        // ---- 非首次：增量更新 ----
        console.log('[tree] refreshCore: 非首次刷新，增量更新');

        // 1. 获取当前 root 的子节点
        const root = await this.etapi.getRoot();
        const currentRootChildIds = root.childNoteIds ?? [];
        const cachedRootChildIds = this.cache.rootChildNoteIds ?? [];

        // 2. 找出新增和删除的子节点
        const addedChildIds = currentRootChildIds.filter(id => !cachedRootChildIds.includes(id));
        const removedChildIds = cachedRootChildIds.filter(id => !currentRootChildIds.includes(id));

        console.log(`[tree] 增量更新: 新增 ${addedChildIds.length} 个, 删除 ${removedChildIds.length} 个子节点`);

        // 3. 删除已不存在的子树
        if (removedChildIds.length > 0) {
          for (const [path, noteId] of Object.entries(this.cache.pathMap)) {
            // 如果某个 path 的 noteId 在删除列表中，或者其父节点在删除列表中，则移除
            if (removedChildIds.includes(noteId)) {
              delete pathMap[path];
              console.log(`[tree] 增量更新: 移除 ${path}`);
            } else {
              pathMap[path] = noteId;
            }
          }
        } else {
          // 没有删除，保留旧缓存
          Object.assign(pathMap, this.cache.pathMap);
        }

        // 4. 遍历新增的子树
        if (addedChildIds.length > 0) {
          for (const childId of addedChildIds) {
            try {
              const childNote = await this.etapi.getNote(childId);
              const childPath = childNote.title;
              console.log(`[tree] 增量更新: 遍历新增子树 "${childPath}" (${childId})`);

              const subFolders = await this.etapi.getSubTree(childId, childPath, 5 * 60 * 1000, 5);
              for (const folder of subFolders) {
                pathMap[folder.path] = folder.noteId;
              }
            } catch (e) {
              console.warn(`[tree] 增量更新: 遍历新增子树 ${childId} 失败`, e);
            }
          }
        }

        // 5. 检查现有子树是否有变化（通过比较子节点数量）
        // 这是一个简化的检查：只检查 root 的直接子节点
        // 更深层的变化需要递归检查，但这样太耗时，暂时跳过

        this.cache = {
          cachedAt: Date.now(),
          pathMap,
          rootChildNoteIds: currentRootChildIds,
          subTreeRoots: this.cache.subTreeRoots,
        };
      }

      this.loaded = true;
      await this.save();
      console.log(`[trilium-sync] 目录树刷新成功，共 ${Object.keys(pathMap).length} 个目录`);
      return pathMap;
    } catch (e) {
      // 永远不抛错！旧缓存还能用就直接用
      console.warn('[trilium-sync] 刷新目录树失败，保留旧缓存:', e);
      // 不设置 loaded=true，让下次同步仍有机会重试
      return this.cache.pathMap;
    }
  }

  // ---- 内部方法 ----

  /**
   * 查找（或创建）某个路径段对应的 noteId
   * pathParts = ['01-每日一志', '2026-04']，从 parentNoteId 开始查找
   * 找不到时自动在 Trilium 中创建对应的"文件夹 Note"
   */
  private async findOrCreatePath(pathParts: string[], parentNoteId: string): Promise<string | null> {
    console.log(`[tree] findOrCreatePath: pathParts=${JSON.stringify(pathParts)}, parentNoteId=${parentNoteId}`);
    let currentParent = parentNoteId;

    for (const segment of pathParts) {
      // 先在当前父节点下找有没有同名子节点
      const found = await this.etapi.findChildByTitle(currentParent, segment);
      if (found) {
        console.log(`[tree]   findChildByTitle 命中: "${segment}" → ${found.noteId}`);
        currentParent = found.noteId;
      } else {
        // 找不到，在 Trilium 中创建一个"文件夹 Note"
        console.warn(`[tree]   findChildByTitle 未找到 "${segment}"，在 parent=${currentParent} 下创建`);
        try {
          const { note } = await this.etapi.createNote({
            parentNoteId: currentParent,
            title: segment,
            type: 'text',
            content: '',
          });
          console.warn(`[tree]   创建了新 Note: "${segment}" → ${note.noteId}，类型=text`);
          currentParent = note.noteId;
          // 立即写入缓存
          const newPath = pathParts.slice(0, pathParts.indexOf(segment) + 1).join('/');
          this.cache.pathMap[newPath] = currentParent;
        } catch (e) {
          console.error(`[tree] 创建中间目录 "${segment}" 失败:`, e);
          return null;
        }
      }
    }

    return currentParent;
  }
}
