import { App, Notice, TFile } from 'obsidian';
import { EtapiClient } from './etapi';
import { IdMapManager } from './idmap';
import { TreeCacheManager } from './tree';
import type { TriliumSyncSettings } from '../settings';
import type { IdMapEntry, TriliumNote } from './types';

/**
 * SyncManager — 同步引擎核心
 *
 * 同步策略（全量扫描，参考老 trilium-sync-old）：
 * - 每次 syncNow() 对每个 syncFolders mapping 做全量扫描
 * - Obsidian → Trilium：比较 mtime，决定 create / update / rename
 * - Trilium → Obsidian：拉取 Trilium 目录，对比本地文件
 * - 处理删除：idMap 有记录但本地文件已不存在的 → 删除 Trilium 笔记
 * - 用 idMap（id-map.json）记录文件→noteId 映射
 *
 * dateNote 规则：
 * - 文件一级目录为 "01-每日一志" 时，创建 dateNote label
 */
export class SyncManager {
  private app: App;
  private settings: TriliumSyncSettings;
  private etapi: EtapiClient | null = null;
  private idMap!: IdMapManager;
  private treeCache: TreeCacheManager | null = null;

  private autoSyncTimer: number | null = null;
  private syncing = false;
  private initFailed = false; // init 失败标志，防止用未初始化的 idMap 同步

  constructor(app: App, settings: TriliumSyncSettings) {
    this.app = app;
    this.settings = settings;
  }

  private async init(): Promise<void> {
    this.idMap = new IdMapManager(this.app);
    await this.idMap.load();

    if (this.etapi) {
      this.treeCache = new TreeCacheManager(this.app, this.etapi);
      await this.treeCache.load();
      // 加载 cachedTriliumFolders，这样后续 refreshCore() 就能查到 mapping 根 noteId
      await this.treeCache.loadCachedFolders();
    }
  }

  private initPromise: Promise<void> | null = null;

  updateSettings(settings: TriliumSyncSettings): void {
    this.settings = settings;
    // 只在 url 或 token 实际变化时才重建 EtapiClient，避免不必要的实例创建
    const newUrl = settings.triliumUrl || '';
    const newToken = settings.etapiToken || '';
    if (newUrl && newToken) {
      if (!this.etapi || this.etapi.getUrl() !== newUrl || this.etapi.getToken() !== newToken) {
        this.etapi = new EtapiClient(newUrl, newToken);
      }
    } else {
      this.etapi = null;
    }

    // 序列化 init，避免并发
    const runInit = (): Promise<void> => {
      if (!this.initPromise) {
        this.initFailed = false;
        this.initPromise = this.init().catch(e => {
          console.error('[trilium-sync] init 失败:', e);
          this.initFailed = true; // 标记失败，syncNow 会拒绝执行
        }).finally(() => {
          this.initPromise = null;
        });
      }
      return this.initPromise;
    };

    runInit().then(() => {
      if (this.autoSyncTimer !== null) {
        this.stopAutoSync();
      }
      if (settings.autoSyncEnabled) {
        this.startAutoSync();
      }
    });
  }

  // ---- 自动同步 ----

  startAutoSync(): void {
    this.stopAutoSync();
    if (!this.etapi) {
      new Notice('[trilium-sync] 请先配置 Trilium 连接');
      return;
    }
    const intervalMs = Math.max(this.settings.syncIntervalSeconds, 30) * 1000;
    this.autoSyncTimer = window.setInterval(() => {
      this.syncNow().catch(e => console.error('[trilium-sync] 自动同步异常:', e));
    }, intervalMs);
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  // ---- 全量同步 ----

  /**
   * 立即同步一次（全量扫描）
   */
  async syncNow(): Promise<void> {
    if (this.syncing) {
      console.log('[trilium-sync] 同步正在进行中，跳过');
      new Notice('[trilium-sync] 同步正在进行中，请稍候');
      return;
    }
    this.syncing = true;
    try {
      await this._doSyncNow();
    } finally {
      this.syncing = false;
    }
  }

  /** syncNow 的实际执行逻辑 */
  private async _doSyncNow(): Promise<void> {
    if (!this.etapi) {
      new Notice('[trilium-sync] 未配置连接');
      return;
    }

    // 等待 init 完成（initPromise 可能还在进行中）
    if (this.initPromise) {
      await this.initPromise;
    }

    // init 失败时拒绝同步，避免用未初始化的 idMap 导致数据丢失
    if (this.initFailed) {
      new Notice('[trilium-sync] 初始化失败，请检查连接配置');
      return;
    }

    const mappings = this.settings.syncFolders.filter(m => m.obsidianPath && m.triliumPath);
    if (mappings.length === 0) {
      new Notice('[trilium-sync] 未配置同步目录');
      return;
    }

    let totalSuccess = 0;
    let totalFailed = 0;
    const errors: string[] = [];

    for (const mapping of mappings) {
      try {
        const result = await this.syncOneMapping(mapping);
        totalSuccess += result.synced;
        totalFailed += result.failed;
        errors.push(...result.errors);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        errors.push(`同步目录 ${mapping.obsidianPath} 失败: ${errMsg}`);
        totalFailed++;
      }
    }

    const msg = totalFailed === 0
      ? `已同步 ${totalSuccess} 个文件 ✓`
      : `同步完成: ${totalSuccess} 成功, ${totalFailed} 失败`;
    new Notice(msg);

    if (errors.length > 0) {
      console.error('[trilium-sync] 同步错误:', errors);
    }

    // 批量保存 idMap（如果有修改）
    await this.idMap.saveIfDirty();
  }

  private async syncOneMapping(mapping: { obsidianPath: string; triliumPath: string }): Promise<{ synced: number; failed: number; errors: string[] }> {
    let synced = 0;
    let failed = 0;
    const errors: string[] = [];

    // 1. Obsidian → Trilium 单向同步（设计初衷：只做这一件事）
    const obsidianResult = await this.syncObsidianToTrilium(mapping);
    synced += obsidianResult.synced;
    failed += obsidianResult.failed;
    errors.push(...obsidianResult.errors);

    // 2. 处理删除：idMap 有记录但本地文件已不存在
    const deleteResult = await this.handleDeletions(mapping);
    synced += deleteResult.synced;
    failed += deleteResult.failed;
    errors.push(...deleteResult.errors);

    return { synced, failed, errors };
  }

  // ---- Obsidian → Trilium ----

  private async syncObsidianToTrilium(
    mapping: { obsidianPath: string; triliumPath: string }
  ): Promise<{ synced: number; failed: number; errors: string[] }> {
    let synced = 0;
    let failed = 0;
    const errors: string[] = [];

    // 获取 Obsidian 目录下所有 .md 文件
    const files = this.getMarkdownFiles(mapping.obsidianPath);

    // ---- 增量同步：只处理启用插件后新建或已修改的文件 ----
    // 注意：删除处理统一由 handleDeletions() 负责，不在这里重复
    for (const file of files) {
      try {
        const result = await this.syncSingleFile(file, mapping);
        if (result.synced) synced++;
        if (result.error) {
          errors.push(result.error);
          failed++;
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        errors.push(`同步文件 ${file.path} 失败: ${errMsg}`);
        failed++;
      }
    }

    return { synced, failed, errors };
  }

  /**
   * 同步单个文件到 Trilium（被 syncObsidianToTrilium 和 syncSpecificFiles 共用）
   * 返回 { synced: 是否实际写入, error?: 错误信息 }
   */
  private async syncSingleFile(
    file: TFile,
    mapping: { obsidianPath: string; triliumPath: string }
  ): Promise<{ synced: boolean; error?: string }> {
    if (!this.etapi) return { synced: false, error: 'ETAPI 客户端未初始化' };
    const filePath = file.path;
    const stat = await this.app.vault.adapter.stat(filePath);
    if (!stat) return { synced: false };

    const fileMtime = new Date(stat.mtime).getTime();
    const fileCtime = new Date(stat.ctime).getTime();

    // 跳过旧文件：没有同步记录且文件创建时间在插件启用之前的
    const existingRecord = this.idMap.get(filePath);
    if (!existingRecord && fileCtime < this.settings.startTime) {
      return { synced: false };
    }

    const content = await this.app.vault.read(file);
    // 预转换一次，后续复用，避免同一文件多次调用 prepareTextContent
    const htmlContent = this.prepareTextContent(content);
    const title = this.filePathToTitle(filePath);
    const relPath = this.getRelativePath(filePath, mapping.obsidianPath);
    const relPathWithoutExt = relPath.replace(/\.md$/, '');
    const triliumFullPath = relPathWithoutExt
      ? `${mapping.triliumPath}/${relPathWithoutExt}`.replace(/\/$/, '')
      : mapping.triliumPath;

    // 查找或创建父目录
    const parentNoteId = await this.etapi!.findOrCreateFolder(this.getParentPath(triliumFullPath));
    if (!parentNoteId) {
      return { synced: false, error: `无法创建父目录: ${triliumFullPath}` };
    }

    // 查同步记录
    if (existingRecord) {
      // 有记录：检查是否需要更新
      const lastSynced = existingRecord.syncedAt ? new Date(existingRecord.syncedAt).getTime() : 0;
      if (fileMtime > lastSynced) {
        const needUpdate = await this.shouldUpdate(existingRecord.noteId, htmlContent, fileMtime);
        if (needUpdate) {
          await this.etapi!.putNoteContent(existingRecord.noteId, htmlContent);
          try {
            const note = await this.etapi!.getNote(existingRecord.noteId);
            const patches: Partial<TriliumNote> = {};
            if (note.type !== 'text') patches.type = 'text' as const;
            if (Object.keys(patches).length > 0) {
              await this.etapi!.patchNote(existingRecord.noteId, patches);
            }
          } catch { /* 忽略 type 更新失败 */ }
          await this.idMap.set(filePath, { ...existingRecord, syncedAt: new Date().toISOString() });
          console.log(`[trilium-sync] 更新: ${title}`);
          return { synced: true };
        }
      }
      return { synced: false };
    } else {
      // 无记录：新建
      const existingNote = await this.etapi!.findChildByTitle(parentNoteId, title);
      if (existingNote) {
        // Trilium 里已有：比较内容是否需要更新
        const triliumContent = await this.etapi!.getNoteContent(existingNote.noteId);
        const needUpdate = htmlContent.trim() !== triliumContent.trim();
        if (needUpdate) {
          await this.etapi!.putNoteContent(existingNote.noteId, htmlContent);
          console.log(`[trilium-sync] 关联已有(更新内容): ${title} → ${existingNote.noteId}`);
        } else {
          console.log(`[trilium-sync] 关联已有(内容一致): ${title} → ${existingNote.noteId}`);
        }
        if (existingNote.type !== 'text') {
          try {
            await this.etapi!.patchNote(existingNote.noteId, { type: 'text' });
          } catch { /* 忽略 */ }
        }
        await this.idMap.set(filePath, {
          noteId: existingNote.noteId,
          title,
          syncedAt: new Date().toISOString(),
        });
      } else {
        // 创建新笔记
        const { note } = await this.etapi!.createNote({
          parentNoteId,
          title,
          type: 'text',
          content: htmlContent,
        });

        // dateNote label
        if (this.isDailyNoteFolder(filePath)) {
          const date = this.extractDateFromPath(filePath);
          if (date) {
            await this.etapi!.createAttribute({
              noteId: note.noteId,
              type: 'label',
              name: 'dateNote',
              value: date,
            });
          }
        }

        await this.idMap.set(filePath, {
          noteId: note.noteId,
          title,
          syncedAt: new Date().toISOString(),
        });
        console.log(`[trilium-sync] 新建: ${title}`);
      }
      return { synced: true };
    }
  }

  /**
   * 增量同步：只同步指定的文件路径（供 modify 事件触发用）
   * 比全量 syncNow() 轻量得多，每个文件最多 2-3 个 API 请求
   */
  async syncSpecificFiles(filePaths: string[]): Promise<void> {
    if (!this.etapi || filePaths.length === 0) return;

    if (this.initPromise) await this.initPromise;

    const mappings = this.settings.syncFolders.filter(m => m.obsidianPath && m.triliumPath);
    let synced = 0;

    for (const filePath of filePaths) {
      // 找到这个文件属于哪个 mapping
      const mapping = mappings.find(m =>
        filePath === m.obsidianPath || filePath.startsWith(m.obsidianPath + '/')
      );
      if (!mapping) continue;

      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!(file instanceof TFile)) continue;

      try {
        const result = await this.syncSingleFile(file, mapping);
        if (result.synced) {
          synced++;
        } else if (result.error) {
          console.error(`[trilium-sync] 增量同步失败: ${filePath}: ${result.error}`);
        }
      } catch (e) {
        console.error(`[trilium-sync] 增量同步异常: ${filePath}`, e);
      }
    }

    await this.idMap.saveIfDirty();

    if (synced > 0) {
      console.log(`[trilium-sync] 增量同步完成，${synced} 个文件`);
    }
  }

  /** 文件重命名时更新 idMap 映射 */
  async renameFileMapping(oldPath: string, newPath: string): Promise<void> {
    await this.idMap.rename(oldPath, newPath);
    await this.idMap.saveIfDirty();
    console.log(`[trilium-sync] 重命名映射: ${oldPath} → ${newPath}`);
  }

  // ---- 处理删除 ----

  private async handleDeletions(
    mapping: { obsidianPath: string; triliumPath: string }
  ): Promise<{ synced: number; failed: number; errors: string[] }> {
    let synced = 0;
    let failed = 0;
    const errors: string[] = [];

    if (!this.etapi) return { synced, failed, errors };

    const files = this.getMarkdownFiles(mapping.obsidianPath);
    const currentFilePaths = new Set(files.map(f => f.path));
    const allRecords = this.idMap.all();
    const mappingPrefix = mapping.obsidianPath + '/';

    for (const [filePath, entry] of Object.entries(allRecords)) {
      if (!filePath.startsWith(mappingPrefix)) continue;
      if (!currentFilePaths.has(filePath) && entry.noteId) {
        try {
          await this.etapi!.deleteNote(entry.noteId);
          await this.idMap.remove(filePath);
          console.log(`[trilium-sync] 删除 Trilium 笔记: ${entry.title}`);
          synced++;
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          errors.push(`删除 ${entry.title} 失败: ${errMsg}`);
          failed++;
        }
      }
    }

    return { synced, failed, errors };
  }

  // ---- 判断是否需要更新 ----

  private async shouldUpdate(noteId: string, localHtmlContent: string, localMtime: number): Promise<boolean> {
    try {
      const note = await this.etapi!.getNote(noteId);
      const triliumMtime = new Date(note.dateModified).getTime();

      if (localMtime > triliumMtime) return true;

      // mtime 不明确时比较内容（localHtmlContent 已经是转换后的 HTML）
      const triliumContent = await this.etapi!.getNoteContent(noteId);
      return localHtmlContent.trim() !== triliumContent.trim();
    } catch {
      return true;
    }
  }

  // ---- 工具方法 ----

  private getMarkdownFiles(dirPath: string): TFile[] {
    return this.app.vault.getMarkdownFiles().filter(f =>
      f.path === dirPath || f.path.startsWith(dirPath + '/')
    );
  }

  private getRelativePath(filePath: string, basePath: string): string {
    if (!basePath) return filePath;
    return filePath.slice(basePath.length + 1);
  }

  private getParentPath(filePath: string): string {
    const parts = filePath.split('/');
    parts.pop();
    return parts.join('/');
  }

  private filePathToTitle(filePath: string): string {
    return filePath.replace(/\.md$/, '').split('/').pop() || filePath;
  }

  private isDailyNoteFolder(filePath: string): boolean {
    const parts = filePath.split('/');
    return parts[0] === '01-每日一志';
  }

  private extractDateFromPath(filePath: string): string | null {
    const filename = filePath.split('/').pop() || '';
    const match = filename.match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? (match[1] ?? null) : null;
  }

  /** 解析表格行：| cell1 | cell2 | → ['cell1', 'cell2'] */
  private parseTableRow(line: string): string[] {
    return line.split('|').slice(1, -1).map(cell => cell.trim());
  }

  /** 解析表格对齐行：|:---|:---:|---:| → ['left', 'center', 'right'] */
  private parseAlignRow(line: string): string[] {
    return line.split('|').slice(1, -1).map(cell => {
      const trimmed = cell.trim();
      if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
      if (trimmed.endsWith(':')) return 'right';
      return 'left';
    });
  }

  /**
   * 将 Obsidian 特有的 HTML 标签转换为标准 HTML（供 Trilium text 类型使用）
   * Obsidian 在 Live Preview 模式下会将样式保存为 <font> 标签，
   * Trilium 的 text/html 渲染器不识别这些标签，导致格式丢失。
   * 解决方案：同步前把 Markdown/HTML 标签转为标准 HTML。
   *
   * 转换规则：
   * - <font color="#..." size="...">内容</font>  → 只保留内容
   * - <br> 或 <br/> → \n（换行）
   * - *** 或 <hr> → ---（水平线）
   * - <div>...</div> → 保留，内部 markdown 继续处理
   * - 其余 HTML 标签 → 直接去掉标签保留内部文本
   * - markdown 语法（**bold**、*italic*、# heading 等）原样保留
   */
  private prepareTextContent(content: string): string {
    let html = content.replace(/\r\n/g, '\n');

    // -1. 数学公式保护（最先，避免 $ 被其他正则干扰）
    const mathPlaceholders = new Map<string, string>();
    // 块级公式：$$...$$
    html = html.replace(/\$\$([\s\S]*?)\$\$/g, (match, content) => {
      const placeholder = `%%MATHBLOCK${mathPlaceholders.size}%%`;
      mathPlaceholders.set(placeholder, `<pre><code>${match}</code></pre>`);
      return placeholder;
    });
    // 行内公式：$...$（不匹配空内容和连续 $$）
    html = html.replace(/(?<!\$)\$(?!\$)([^\$\n]+?)\$(?!\$)/g, (match, content) => {
      const placeholder = `%%MATHINLINE${mathPlaceholders.size}%%`;
      mathPlaceholders.set(placeholder, `<code>${match}</code>`);
      return placeholder;
    });

    // 0. 先用占位符保护代码块，避免转换过程被破坏
    const codeBlockPlaceholders = new Map<string, string>();
    html = html.replace(/```[\s\S]*?```/g, (match) => {
      const placeholder = `%%CODEBLOCK${codeBlockPlaceholders.size}%%`;
      codeBlockPlaceholders.set(placeholder, match);
      return placeholder;
    });



    // 1. 水平线：*** 或 --- → <hr>
    html = html.replace(/^(\*{3,}|-{3,})$/gm, '<hr>');

    // 2. 标题：# ## ### #### ##### ###### → <h1>~<h6>（保留层级）
    html = html.replace(/^######\s+(.*)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.*)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.*)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.*)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.*)$/gm, '<h1>$1</h1>');

    // 3. 粗体：**text** 或 __text__ → <strong>text</strong>
    html = html.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');

    // 4. 斜体：*text* 或 _text_ → <em>text</em>
    html = html.replace(/(?<!\*)\*([^\*\n]+)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');

    // 5. 高亮：==text== → <mark>text</mark>
    html = html.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');

    // 6. 删除线：~~text~~ → <del>text</del>
    html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // 6. 行内代码：`code` → <code>code</code>
    html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // 8. 图片：![alt](url) → <img src="url" alt="alt">（必须先于链接匹配，否则 ![alt](url) 的 [alt](url) 被链接正则吃掉）
    html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">');

    // 7. 链接：[text](url) → <a href="url">text</a>（图片已处理完毕，不会误匹配）
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');

    // 7b. Wiki 链接：[[页面名|别名]] → <a>别名</a>，[[页面名]] → <a>页面名</a>
    html = html.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '<a>$2</a>');
    html = html.replace(/\[\[([^\]]+)\]\]/g, '<a>$1</a>');

    // 7c. 脚注：收集 [^id]: 定义，替换 [^id] 为上标引用，末尾生成脚注列表
    {
      const fnLines = html.split('\n');
      const footnoteDefs = new Map<string, string>();
      const fnBodyLines: string[] = [];
      const fnDefRegex = /^\[\^([^\]]+)\]:\s*(.*)$/;
      for (const line of fnLines) {
        const match = line.trim().match(fnDefRegex);
        if (match) {
          footnoteDefs.set(match[1]!, match[2] ?? '');
        } else {
          fnBodyLines.push(line);
        }
      }
      html = fnBodyLines.join('\n');

      // 生成随机 ID（模拟 Trilium 的 10 位字母数字 ID）
      const genId = () => {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let id = '';
        for (let i = 0; i < 10; i++) id += chars[Math.floor(Math.random() * chars.length)];
        return id;
      };

      // 替换引用 [^id] → Trilium 原生 footnote-reference 格式（含 data-footnote-id）
      const usedFootnotes = new Map<string, { idx: number; fnId: string }>();
      let fnCounter = 0;
      html = html.replace(/\[\^([^\]]+)\]/g, (match, id: string) => {
        if (!footnoteDefs.has(id)) return match;
        if (!usedFootnotes.has(id)) {
          fnCounter++;
          usedFootnotes.set(id, { idx: fnCounter, fnId: genId() });
        }
        const { idx, fnId } = usedFootnotes.get(id)!;
        // 完全匹配 Trilium 原生格式：span.footnote-reference 含 data-footnote-id
        return `<span class="footnote-reference" data-footnote-reference="" data-footnote-index="${idx}" data-footnote-id="${fnId}" role="doc-noteref" id="fnref${fnId}"><sup><a href="#fn${fnId}">[${idx}]</a></sup></span>`;
      });

      // 末尾生成脚注列表（Trilium 原生格式，含 data-footnote-id）
      if (usedFootnotes.size > 0) {
        let fnList = '\n<ol class="footnote-section footnotes" data-footnote-section="" role="doc-endnotes">';
        for (const [, { idx, fnId }] of usedFootnotes) {
          const content = footnoteDefs.get([...usedFootnotes].find(([k, v]) => v.fnId === fnId)![0]) ?? '';
          // li.footnote-item 含 data-footnote-id
          fnList += `<li class="footnote-item" data-footnote-item="" data-footnote-index="${idx}" data-footnote-id="${fnId}" role="doc-endnote" id="fn${fnId}">`;
          // span.footnote-back-link 含 data-footnote-id
          fnList += `<span class="footnote-back-link" data-footnote-back-link="" data-footnote-id="${fnId}"><sup><strong><a href="#fnref${fnId}">^</a></strong></sup></span>`;
          // div.footnote-content
          fnList += `<div class="footnote-content" data-footnote-content=""><p>${content}</p></div>`;
          fnList += `</li>`;
        }
        fnList += '</ol>';
        html += fnList;
      }
    }

    // 8b. 表格：| header | → <table>（必须在 \n→<br> 转换之前，需要原始换行符）
    {
      const tblLines = html.split('\n');
      const tblResult: string[] = [];
      let tblIdx = 0;
      while (tblIdx < tblLines.length) {
        const curLine = tblLines[tblIdx] ?? '';
        const line = curLine.trim();
        if (line.startsWith('|') && line.endsWith('|') && tblIdx + 1 < tblLines.length) {
          const nextLine = (tblLines[tblIdx + 1] ?? '').trim();
          const separatorRegex = /^\|[\s\-:]+(\|[\s\-:]+)*\|$/;
          if (separatorRegex.test(nextLine)) {
            const headers = this.parseTableRow(curLine);
            const aligns = this.parseAlignRow(nextLine);
            const rows: string[][] = [];
            let j = tblIdx + 2;
            while (j < tblLines.length && (tblLines[j] ?? '').trim().startsWith('|')) {
              rows.push(this.parseTableRow(tblLines[j]!));
              j++;
            }
            let tableHtml = '<table><thead><tr>';
            for (let h = 0; h < headers.length; h++) {
              tableHtml += `<th>${headers[h]}</th>`;
            }
            tableHtml += '</tr></thead><tbody>';
            for (const row of rows) {
              tableHtml += '<tr>';
              for (let c = 0; c < headers.length; c++) {
                tableHtml += `<td>${row[c] || ''}</td>`;
              }
              tableHtml += '</tr>';
            }
            tableHtml += '</tbody></table>';
            tblResult.push(tableHtml);
            tblIdx = j;
            continue;
          }
        }
        tblResult.push(curLine);
        tblIdx++;
      }
      html = tblResult.join('\n');
    }

    // 9. 引用：> quote → <blockquote>quote</blockquote>
    // 支持多段落引用（空行分隔的多段引用合并为一个 blockquote）
    // 支持 admonition 语法：> [!NOTE]、> [!WARNING] 等 → 带标题的 blockquote
    {
      const bqLines = html.split('\n');
      const bqResult: string[] = [];
      let bqContent: string[] = [];
      let inBq = false;

      for (const line of bqLines) {
        const isQuoteLine = /^>\s*/.test(line);
        const isEmpty = line.trim() === '';

        if (isQuoteLine) {
          bqContent.push(line.replace(/^>\s*/, ''));
          inBq = true;
        } else if (isEmpty && inBq) {
          // 检查当前内容是否是 admonition（以 [!TYPE] 开头）
          const isAdmonition = bqContent[0]?.match(/^\[!([A-Z]+)\]/i);
          if (isAdmonition) {
            // admonition 遇到空行就结束（多个 admonition 之间用空行分隔，应各自独立）
            bqResult.push(this.buildBlockquoteHtml(bqContent));
            bqContent = [];
            inBq = false;
          } else {
            // 普通引用保留空行（支持多段落）
            bqContent.push('');
          }
        } else {
          if (inBq) {
            bqResult.push(this.buildBlockquoteHtml(bqContent));
            bqContent = [];
            inBq = false;
          }
          bqResult.push(line);
        }
      }
      if (inBq) {
        bqResult.push(this.buildBlockquoteHtml(bqContent));
      }
      html = bqResult.join('\n');
    }

    // 10. 无序列表：- item 或 * item → 嵌套的 <ul><li> 结构
    // 先将列表项转为带缩进信息的临时格式
    // 同时处理 checkbox：- [ ] / - [x] → <input type="checkbox">
    const listLines: {indent: number, content: string}[] = [];
    html = html.replace(/^([ \t]*)[\*\-\+]\s+(.*)$/gm, (match, indent, content) => {
      const indentLevel = indent.length;
      // 检测 checkbox 语法：[ ] 或 [x]（不区分大小写）
      let processedContent = content;
      const uncheckedMatch = content.match(/^\[ \]\s*(.*)/);
      const checkedMatch = content.match(/^\[x\]\s*(.*)/i);
      if (uncheckedMatch) {
        processedContent = `<input type="checkbox"> ${uncheckedMatch[1]}`;
      } else if (checkedMatch) {
        processedContent = `<input type="checkbox" checked> ${checkedMatch[1]}`;
      }
      listLines.push({ indent: indentLevel, content: processedContent });
      return `___LIST_${listLines.length - 1}___`;
    });

    // 如果有列表项，构建嵌套结构
    if (listLines.length > 0) {
      // 构建嵌套 HTML
      const buildNestedList = (items: {indent: number, content: string}[], startIdx: number, currentIndent: number): {html: string, nextIdx: number} => {
        let result = '<ul>';
        let i = startIdx;
        while (i < items.length) {
          const item = items[i];
          if (!item) break;
          if (item.indent < currentIndent) {
            break; // 回到上一层
          } else if (item.indent === currentIndent) {
            // 同一层级
            result += `<li>${item.content}`;
            i++;
            // 检查是否有子项
            const nextItem = items[i];
            if (nextItem && nextItem.indent > currentIndent) {
              const nested = buildNestedList(items, i, nextItem.indent);
              result += nested.html;
              i = nested.nextIdx;
            }
            result += '</li>';
          } else {
            break; // 不应该出现
          }
        }
        result += '</ul>';
        return { html: result, nextIdx: i } as {html: string, nextIdx: number};
      };

      // 按 HTML 行遍历，遇到 heading 时重置上下文，每个 heading 有独立的列表
      const lines = html.split('\n');
      const resultLines: string[] = [];
      let currentListItems: { indent: number, content: string }[] = [];

      const flushList = (): string => {
        if (currentListItems.length === 0) return '';
        // 构建嵌套列表 HTML
        const build = (items: { indent: number, content: string }[], startIdx: number, currentIndent: number): { html: string, nextIdx: number } => {
          let res = '<ul>';
          let i = startIdx;
          while (i < items.length) {
            const item = items[i];
            if (!item) break;
            if (item.indent < currentIndent) break;
            else if (item.indent === currentIndent) {
              res += `<li>${item.content}`;
              i++;
              const next = items[i];
              if (next && next.indent > currentIndent) {
                const n = build(items, i, next.indent);
                res += n.html;
                i = n.nextIdx;
              }
              res += '</li>';
            } else break;
          }
          res += '</ul>';
          return { html: res, nextIdx: i };
        };
        const first = currentListItems[0];
        return first ? build(currentListItems, 0, first.indent).html : '';
      };

      for (const line of lines) {
        const isHeading = /^<h[1-6]>/.test(line);
        const isListPlaceholder = /^___LIST_\d+___$/.test(line.trim());
        const isBlockquote = /^<blockquote|^<aside class="admonition/.test(line);
        const isTable = /^<table>/.test(line.trim());

        // 遇到 heading 或 blockquote 或 table：先 flush 当前列表，再输出
        if (isHeading || isBlockquote || isTable) {
          const listHtml = flushList();
          currentListItems = [];
          if (listHtml) resultLines.push(listHtml);
          resultLines.push(line);
        } else if (isListPlaceholder) {
          // 列表占位符行：只收集，不单独输出（后续 flush 会输出）
          const trimmed = line.trim();
          const idx = parseInt(trimmed.match(/___LIST_(\d+)___/)?.[1] ?? '0');
          const original = listLines[idx];
          if (original) currentListItems.push(original);
        } else {
          // 非 heading/非占位符行：flush 当前列表（因为进入了普通段落）
          const listHtml = flushList();
          if (listHtml) {
            resultLines.push(listHtml);
            currentListItems = [];
          }
          resultLines.push(line);
        }
      }
      // 最后 flush
      const lastListHtml = flushList();
      if (lastListHtml) resultLines.push(lastListHtml);

      // 拼接：heading 后面立即接 list 时不加换行符，避免 <h1>\\n<ul> → <br><br>
      const out: string[] = [];
      for (let i = 0; i < resultLines.length; i++) {
        const curr: string = resultLines[i] ?? '';
        const prev: string | undefined = resultLines[i - 1];
        const next: string | undefined = resultLines[i + 1];
        const prevIsHeading = prev !== undefined && /^<h[1-6]>/.test(prev);
        const nextIsList = next !== undefined && (next.startsWith('<ul>') || next.startsWith('<ol>'));
        // 保留空行（用户故意留的空段落），不跳过
        if (prevIsHeading && nextIsList) {
          out.push(curr); // heading 后紧跟 list：不加 \n
        } else {
          out.push(curr + '\n');
        }
      }
      html = out.join('');
    }

    // 11. 有序列表：1. item → <ol><li>item</li></ol>
    // 使用更安全的占位符，避免与用户内容冲突
    const oliPlaceholders: string[] = [];
    html = html.replace(/^\d+\.\s+(.*)$/gm, (match, content) => {
      const placeholder = `___OLI_${oliPlaceholders.length}___`;
      oliPlaceholders.push(content);
      return placeholder;
    });
    // 合并连续的占位符为 <ol>
    if (oliPlaceholders.length > 0) {
      const olRegex = /(___OLI_\d+___\n?)+/g;
      html = html.replace(olRegex, (match) => {
        const indices: number[] = [];
        let m;
        const re = /___OLI_(\d+)___/g;
        while ((m = re.exec(match)) !== null) {
          if (m[1]) {
            indices.push(parseInt(m[1]));
          }
        }
        const items = indices
          .map(i => oliPlaceholders[i])
          .filter((content): content is string => content !== undefined)
          .map(content => `<li>${content}</li>`)
          .join('');
        return `<ol>${items}</ol>`;
      });
    }

    // 12. 双换行 → 段落分隔
    html = html.replace(/\n\n/g, '<br><br>');
    // 13. 单换行 → <br>
    html = html.replace(/\n/g, '<br>');

    // 14. 清理水平线周围多余空行
    // 上方：任意连续 <br> 组合 + <hr> → <hr>
    for (let i = 0; i < 10; i++) {
      html = html.replace(/(<br>)+<hr>/g, '<hr>');
    }
    // 下方：<hr> + 任意连续 <br> 组合 → <hr>
    for (let i = 0; i < 10; i++) {
      html = html.replace(/<hr>(<br>)+/g, '<hr>');
    }
    // 兜底：如果 <hr> 旁边还有零散的 <br>（如 <br><hr> 但上方没有更多 <br>），也清理掉
    // 比如 <font>...\n***\n* 会变成 <font>...<br><hr><br>*，上面两个循环清理后剩 <br>*，再清理一次
    for (let i = 0; i < 10; i++) {
      const before = html;
      html = html.replace(/<br><hr>/g, '<hr>');
      html = html.replace(/<hr><br>/g, '<hr>');
      if (html === before) break;
    }

    // 15. 清理块级元素之间的多余 <br>（Trilium 渲染时每个 <br> 都是空行）
    // 块级元素自己控制间距，不需要 <br> 来分隔
    // 先保护用户故意留的空行（<br><br>），清理完再恢复
    const blockTags = 'h[1-6]|ul|ol|li|blockquote|div|p|hr|pre|table|thead|tbody|tr|th|td|aside';
    // 结构性块元素（自带 margin，不需要额外空行）
    const structuralTags = 'h[1-6]|ul|ol|blockquote|aside|hr|table|pre';
    html = html.replace(/<br><br>/g, '___BRBR___');
    // 闭合块标签后的单个 <br>：如 </h1><br> → </h1>
    html = html.replace(new RegExp(`(<\\/(${blockTags})>)<br>`, 'gi'), '$1');
    // 开放块标签前的单个 <br>：如 <br><ul> → <ul>
    html = html.replace(new RegExp(`<br>(<(${blockTags})(?:\\s[^>]*)?>)`, 'gi'), '$1');
    // 结构性块元素之间的 ___BRBR___ 也清理（它们自带 margin，不需要额外空行）
    // 如 </ul><br><br><ul> → </ul><ul>，但 </p><br><br><p> 保留
    html = html.replace(new RegExp(`(<\\/(?:${structuralTags})>)___BRBR___(<(?:${structuralTags})(?:\\s[^>]*)?>)`, 'gi'), '$1$2');
    // 恢复空行
    html = html.replace(/___BRBR___/g, '<br><br>');

    // 16. 恢复代码块占位符
    codeBlockPlaceholders.forEach((original, placeholder) => {
      // 代码块内容保留原始格式，包括换行符
      let block = original.replace(/^```[^\n]*\n/, ''); // 去掉开头 ```
      block = block.replace(/\n```$/, ''); // 去掉结尾 ```
      // 代码块内保留 \n，不转为 <br>，使用 <pre> 标签保留格式
      // 用函数替换避免内容中的 $$ 被 String.replace 解释为转义 $
      html = html.replace(placeholder, () => `<pre><code>${block}</code></pre>`);
    });

    // 17. 恢复数学公式占位符（用函数替换，避免 $$ 被 String.replace 解释为转义 $）
    mathPlaceholders.forEach((original, placeholder) => {
      html = html.replace(placeholder, () => original);
    });

    return html;
  }

  /** 构建 blockquote HTML（支持多段落和 admonition） */
  private buildBlockquoteHtml(contentLines: string[]): string {
    // 检查是否为 admonition：> [!TYPE] 或 > [!TYPE] Title
    const firstNonEmpty = contentLines.find(l => l.trim() !== '');
    const admonitionMatch = firstNonEmpty?.match(/^\[!([A-Z]+)\]\s*(.*)$/i);

    if (admonitionMatch) {
      const type = admonitionMatch[1]?.toLowerCase() || 'note';
      const customTitle = admonitionMatch[2]?.trim();
      // 移除 [!TYPE] 行，剩余内容作为 body
      const firstIdx = contentLines.indexOf(firstNonEmpty!);
      const bodyLines = contentLines.slice(firstIdx + 1);
      const paragraphs = this.splitIntoParagraphs(bodyLines);
      const bodyHtml = paragraphs.map(p => `<p>${p.join('<br>')}</p>`).join('');
      // Trilium admonition 格式：<aside class="admonition 类型">
      // 自定义标题作为 <strong> 放在内容前面
      const titleHtml = customTitle ? `<p><strong>${customTitle}</strong></p>` : '';
      return `<aside class="admonition ${type}">${titleHtml}${bodyHtml}</aside>`;
    }

    // 普通引用：按空行分段，每段用 <p> 包裹（支持多段落）
    const paragraphs = this.splitIntoParagraphs(contentLines);
    const contentHtml = paragraphs.map(p => `<p>${p.join('<br>')}</p>`).join('');
    return `<blockquote>${contentHtml}</blockquote>`;
  }

  /** 将行数组按空行分割成段落 */
  private splitIntoParagraphs(lines: string[]): string[][] {
    const paragraphs: string[][] = [];
    let current: string[] = [];

    for (const line of lines) {
      if (line.trim() === '') {
        if (current.length > 0) {
          paragraphs.push(current);
          current = [];
        }
      } else {
        current.push(line);
      }
    }
    if (current.length > 0) {
      paragraphs.push(current);
    }

    return paragraphs.length > 0 ? paragraphs : [[]];
  }

  /** 刷新 Trilium 目录树缓存（供设置界面调用） */
  async refreshTreeCache(onRefreshed?: (pathMap: Record<string, string>) => void): Promise<void> {
    if (!this.treeCache) {
      new Notice('[trilium-sync] 未初始化连接');
      return;
    }
    try {
      // 提取当前 settings 里的 triliumPath 列表，用于只抓 mapping 相关子树
      const triliumMappings = (this.settings.syncFolders ?? [])
        .filter(m => m.triliumPath)
        .map(m => m.triliumPath);
      const pathMap = await this.treeCache.refresh(triliumMappings);
      if (onRefreshed) {
        onRefreshed(pathMap);
      }
      new Notice('Trilium 目录树已刷新 ✓');
    } catch (e) {
      new Notice('刷新目录树失败');
      throw e;
    }
  }
}
