import { requestUrl } from 'obsidian';
import type {
  TriliumNote,
  TriliumAttribute,
  TriliumBranch,
  CreateNoteRequest,
  CreateAttributeRequest,
  TreeNode,
} from './types';

export class EtapiClient {
  private baseUrl: string;
  private token: string;
  private cachedRootTitle: string | null = null;
  private rootTitleCacheTime: number = 0;
  private static readonly ROOT_CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  /** 获取当前 URL（供 updateSettings 判断是否需要重建） */
  getUrl(): string { return this.baseUrl; }

  /** 获取当前 Token（供 updateSettings 判断是否需要重建） */
  getToken(): string { return this.token; }

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: object | string,
  ): Promise<T> {
    const url = `${this.baseUrl}/etapi${path}`;
    const headers = this.headers();

    const options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      throw?: boolean;
    } = {
      url,
      method,
      headers,
      throw: false,
    };

    if (body !== undefined) {
      if (typeof body === 'string') {
        options.body = body;
      } else {
        options.body = JSON.stringify(body);
      }
    }

    // 使用 Obsidian 内置 requestUrl，绕过 CORS 限制
    const response = await requestUrl(options);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`ETAPI ${method} ${path} failed ${response.status}: ${response.text}`);
    }

    // 204 No Content
    if (response.status === 204) return {} as T;

    return JSON.parse(response.text);
  }

  // ---- Notes ----

  /** 创建 Note，返回 { note, branch } */
  async createNote(data: CreateNoteRequest): Promise<{ note: TriliumNote; branch: unknown }> {
    return this.request('POST', '/create-note', data);
  }

  /** 获取 Note 元数据 */
  async getNote(noteId: string): Promise<TriliumNote> {
    return this.request('GET', `/notes/${noteId}`);
  }

  /** 更新 Note 元数据（标题等） */
  async patchNote(noteId: string, data: Partial<TriliumNote>): Promise<TriliumNote> {
    return this.request('PATCH', `/notes/${noteId}`, data);
  }

  /** 删除 Note */
  async deleteNote(noteId: string): Promise<void> {
    await this.request('DELETE', `/notes/${noteId}`);
  }

  /** 获取 Note 内容 */
  async getNoteContent(noteId: string): Promise<string> {
    const url = `${this.baseUrl}/etapi/notes/${noteId}/content`;
    const response = await requestUrl({
      url,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.token}` },
      throw: false,
    });
    if (response.status !== 200) throw new Error(`getNoteContent failed ${response.status}`);
    return response.text;
  }

  /** 更新 Note 内容（Content-Type: text/plain，不走 JSON 包装） */
  async putNoteContent(noteId: string, content: string): Promise<void> {
    const url = `${this.baseUrl}/etapi/notes/${noteId}/content`;
    const response = await requestUrl({
      url,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'text/plain',
      },
      body: content,
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`PUT /notes/${noteId}/content failed ${response.status}: ${response.text}`);
    }
  }

  /** 搜索 Notes */
  async searchNotes(params: {
    search?: string;
    ancestorNoteId?: string;
    limit?: number;
  }): Promise<{ results: TriliumNote[] }> {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.ancestorNoteId) qs.set('ancestorNoteId', params.ancestorNoteId);
    if (params.limit) qs.set('limit', String(params.limit));
    return this.request('GET', `/notes?${qs}`);
  }

  /**
   * 获取 Note 的直接子节点 noteId 列表
   * 新版 TriliumNext 用 childNoteIds，不再用 branches 查询接口
   */
  async getChildNoteIds(noteId: string): Promise<string[]> {
    const note = await this.getNote(noteId);
    return note.childNoteIds ?? [];
  }

  /**
   * 获取 Note 的直接子节点信息（noteId + title）
   * 优化版：一次请求获取所有子节点信息，避免重复调用 getNote
   */
  async getChildNoteTitles(noteId: string): Promise<{noteId: string, title: string}[]> {
    const note = await this.getNote(noteId);
    const childIds = note.childNoteIds ?? [];
    if (childIds.length === 0) return [];

    // 并发获取所有子节点信息
    const children = await Promise.all(
      childIds.map(async (childId) => {
        try {
          const childNote = await this.getNote(childId);
          return { noteId: childId, title: childNote.title };
        } catch {
          // 无权访问的节点跳过
          return null;
        }
      })
    );

    // 过滤掉失败的
    return children.filter((c): c is {noteId: string, title: string} => c !== null);
  }

  /**
   * 获取 Note 的直接子节点（模拟旧版 branches 格式）
   * 注意：内部已改用 getChildNoteTitles，此方法仅供兼容
   */
  async getNoteBranches(noteId: string): Promise<TriliumBranch[]> {
    const childIds = await this.getChildNoteIds(noteId);
    // 模拟旧版 branches 返回格式：只取 noteId 字段
    return childIds.map(noteId => ({ noteId } as TriliumBranch));
  }

  /** 获取完整笔记树（从指定 noteId 向下递归） */
  async fetchNoteTree(noteId: string, depth = 3): Promise<TreeNode> {
    const note = await this.getNote(noteId);
    const children: TreeNode[] = [];

    if (depth > 0) {
      // 使用优化方法获取子节点信息
      const childNotes = await this.getChildNoteTitles(noteId);
      for (const childNote of childNotes) {
        try {
          const child = await this.fetchNoteTree(childNote.noteId, depth - 1);
          children.push(child);
        } catch {
          // 子节点可能无权访问，跳过
        }
      }
    }

    return { noteId: note.noteId, title: note.title, type: note.type, children };
  }

  /** 获取 root 节点信息 */
  async getRoot(): Promise<TriliumNote> {
    return this.request('GET', '/notes/root');
  }

  /** 获取缓存的 root 标题（5分钟内有效） */
  private async getCachedRootTitle(): Promise<string | null> {
    const now = Date.now();
    if (this.cachedRootTitle && (now - this.rootTitleCacheTime) < EtapiClient.ROOT_CACHE_TTL) {
      return this.cachedRootTitle;
    }
    try {
      const root = await this.getRoot();
      this.cachedRootTitle = root.title;
      this.rootTitleCacheTime = now;
      return root.title;
    } catch {
      return this.cachedRootTitle; // 失败时返回旧缓存
    }
  }

  /** 根据标题在父节点下搜索直接子节点（精确匹配） */
  async findChildByTitle(parentNoteId: string, title: string): Promise<TriliumNote | null> {
    // 优化：使用 searchNotes 做服务端过滤，减少 API 调用次数
    // 用 ancestorNoteId 限制搜索范围，用 title 精确匹配
    try {
      const result = await this.searchNotes({
        search: title,
        ancestorNoteId: parentNoteId,
        limit: 10,  // 限制结果数量，提高效率
      });

      // 精确匹配标题
      for (const note of result.results) {
        if (note.title === title) {
          return note;
        }
      }

      // searchNotes 成功但没有精确匹配 → 走 fallback 逐一比对
    } catch {
      // 搜索失败时回退到旧方法
    }

    // Fallback：使用 getChildNoteTitles 逐一精确比对 title
    // 注意：Trilium 的 searchNotes 是模糊搜索，即使 ancestorNoteId 限制范围，
    // 也可能返回内容包含关键词但标题不同的笔记，导致精确匹配失败
    const childNotes = await this.getChildNoteTitles(parentNoteId);
    for (const child of childNotes) {
      if (child.title === title) {
        try {
          return await this.getNote(child.noteId);
        } catch {
          // 忽略
        }
      }
    }
    return null;
  }

  /**
   * 查找或创建路径中的文件夹 Note（逐级查找/创建，简单可靠）
   * triliumPath 如 "01-每日一志/2026/2026-04"，返回最终父目录的 noteId
   * 注意：Trilium 里没有真正的文件夹，所有目录都是 text 类型的 Note
   */
  async findOrCreateFolder(triliumPath: string): Promise<string | null> {
    const parts = triliumPath.split('/').filter(p => p);
    if (parts.length === 0) return null;

    // 检查配置路径是否带了 root 标题，如果有则跳过第一段
    let startIndex = 0;
    // 使用缓存的 root 标题，避免每次都请求
    const rootTitle = await this.getCachedRootTitle();
    if (rootTitle && parts[0] === rootTitle) {
      startIndex = 1;
    }

    // 从 root noteId 开始逐级往下走
    let currentParentId = 'root';

    for (let i = startIndex; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      let note = await this.findChildByTitle(currentParentId, part);
      if (!note) {
        // 找不到就创建（用 text 类型充当文件夹）
        try {
          const result = await this.createNote({
            parentNoteId: currentParentId,
            title: part,
            type: 'text',
            content: '',
          });
          note = result.note;
        } catch (e) {
          console.error(`[etapi] 创建目录 "${part}" 失败:`, e);
          return null;
        }
      }
      currentParentId = note.noteId;
    }

    return currentParentId;
  }

  // ---- Attributes ----

  /** 创建 label 或 relation */
  async createAttribute(data: CreateAttributeRequest): Promise<TriliumAttribute> {
    return this.request('POST', '/attributes', data);
  }

  /** 获取属性 */
  async getAttribute(attributeId: string): Promise<TriliumAttribute> {
    return this.request('GET', `/attributes/${attributeId}`);
  }

  /** 更新属性（只能改 value 和 position） */
  async patchAttribute(attributeId: string, data: { value?: string; position?: number }): Promise<TriliumAttribute> {
    return this.request('PATCH', `/attributes/${attributeId}`, data);
  }

  /** 删除属性 */
  async deleteAttribute(attributeId: string): Promise<void> {
    await this.request('DELETE', `/attributes/${attributeId}`);
  }

  // ---- Branches ----

  /** 创建分支（将 Note 挂到某父节点下） */
  async createBranch(data: {
    noteId: string;
    parentNoteId: string;
    prefix?: string;
    notePosition?: number;
  }): Promise<unknown> {
    return this.request('POST', '/branches', data);
  }

  // ---- App Info ----

  /** 测试连接 */
  async getAppInfo(): Promise<{ appVersion: string }> {
    return this.request('GET', '/app-info');
  }

  // ---- 目录树 ----

  /**
   * 获取完整的 Trilium 目录树（路径格式）
   * 递归遍历所有后代节点，返回 {path, noteId} 列表
   * @param timeoutMs 超时毫秒数，默认 10 分钟；超时后返回已获取的部分
   * @param concurrency 并发数，默认 5
   */
  async getFolderTree(timeoutMs = 10 * 60 * 1000, concurrency = 5): Promise<{ path: string; noteId: string }[]> {
    const resultRef: { folders: { path: string; noteId: string }[] } = { folders: [] };
    const cancelledRef: { cancelled: boolean } = { cancelled: false };

    await Promise.race([
      this._getFolderTreeImpl(resultRef, cancelledRef, concurrency),
      new Promise<null>(resolve => setTimeout(() => {
        cancelledRef.cancelled = true;
        resolve(null);
      }, timeoutMs)),
    ]);

    resultRef.folders.sort((a, b) => a.path.localeCompare(b.path));
    return resultRef.folders;
  }

  /**
   * 增量获取 Trilium 目录树（只获取指定子树）
   * @param rootNoteId 根节点 noteId
   * @param rootPath 根节点路径
   * @param timeoutMs 超时毫秒数
   * @param concurrency 并发数
   */
  async getSubTree(
    rootNoteId: string,
    rootPath: string,
    timeoutMs = 5 * 60 * 1000,
    concurrency = 5
  ): Promise<{ path: string; noteId: string }[]> {
    const resultRef: { folders: { path: string; noteId: string }[] } = { folders: [] };
    const cancelledRef: { cancelled: boolean } = { cancelled: false };

    await Promise.race([
      this._getSubTreeImpl(rootNoteId, rootPath, resultRef, cancelledRef, concurrency),
      new Promise<null>(resolve => setTimeout(() => {
        cancelledRef.cancelled = true;
        resolve(null);
      }, timeoutMs)),
    ]);

    return resultRef.folders;
  }

  /** getFolderTree 的实际实现（并发版本） */
  private async _getFolderTreeImpl(
    resultRef: { folders: { path: string; noteId: string }[] },
    cancelledRef: { cancelled: boolean },
    concurrency: number
  ): Promise<void> {
    const folders = resultRef.folders;
    const visited = new Set<string>();

    // 从 root 开始
    const root = await this.getRoot();
    const queue: { noteId: string; parentPath: string }[] = [];

    if (root.childNoteIds) {
      for (const childId of root.childNoteIds) {
        if (childId !== '_hidden') {
          queue.push({ noteId: childId, parentPath: '' });
        }
      }
    }

    // 并发处理队列
    await this._processQueue(queue, folders, visited, cancelledRef, concurrency);
  }

  /** getSubTree 的实际实现 */
  private async _getSubTreeImpl(
    rootNoteId: string,
    rootPath: string,
    resultRef: { folders: { path: string; noteId: string }[] },
    cancelledRef: { cancelled: boolean },
    concurrency: number
  ): Promise<void> {
    const folders = resultRef.folders;
    const visited = new Set<string>();

    // 先获取根节点信息
    try {
      const rootNote = await this.getNote(rootNoteId);
      // 根节点本身也加入结果
      folders.push({ path: rootPath, noteId: rootNoteId });

      const queue: { noteId: string; parentPath: string }[] = [];
      if (rootNote.childNoteIds) {
        for (const childId of rootNote.childNoteIds) {
          if (!visited.has(childId)) {
            queue.push({ noteId: childId, parentPath: rootPath });
          }
        }
      }

      await this._processQueue(queue, folders, visited, cancelledRef, concurrency);
    } catch (e) {
      console.error(`[etapi] getSubTree 失败: ${rootNoteId}`, e);
    }
  }

  /** 并发处理队列 */
  private async _processQueue(
    queue: { noteId: string; parentPath: string }[],
    folders: { path: string; noteId: string }[],
    visited: Set<string>,
    cancelledRef: { cancelled: boolean },
    concurrency: number
  ): Promise<void> {
    // 尊重调用方传入的并发数，上限 20 防止服务端过载
    const effectiveConcurrency = Math.min(Math.max(concurrency, 1), 20);

    while (queue.length > 0) {
      if (cancelledRef.cancelled) {
        console.log('[etapi] 目录树遍历已取消，返回已获取的部分结果');
        return;
      }

      // 取出一批任务（最多 effectiveConcurrency 个）
      const batch = queue.splice(0, effectiveConcurrency);

      // 并发处理这批任务，使用 Promise.allSettled 但不等待所有完成
      const results = await Promise.allSettled(
        batch.map(async ({ noteId, parentPath }) => {
          if (visited.has(noteId)) return null;
          visited.add(noteId);

          const note = await this.getNote(noteId);
          const currentPath = parentPath ? `${parentPath}/${note.title}` : note.title;

          return { note, currentPath };
        })
      );

      // 处理结果，将子节点加入队列
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          const { note, currentPath } = result.value;

          if (note.childNoteIds && note.childNoteIds.length > 0) {
            folders.push({ path: currentPath, noteId: note.noteId });

            for (const childId of note.childNoteIds) {
              if (!visited.has(childId)) {
                queue.push({ noteId: childId, parentPath: currentPath });
              }
            }
          }
        }
        // rejected 的情况静默跳过（无权访问等）
      }
    }
  }
}
