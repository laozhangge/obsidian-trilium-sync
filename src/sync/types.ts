// Obsidian 插件配置

/** 单条同步目录映射 */
export interface SyncFolderMapping {
  /** Obsidian 端的目录路径 */
  obsidianPath: string;
  /** Trilium 端的目录路径（相对于 root） */
  triliumPath: string;
}

export interface TriliumSyncSettings {
  triliumUrl: string;
  etapiToken: string;
  autoSyncEnabled: boolean;
  syncIntervalSeconds: number;
  /** 同步目录映射列表 */
  syncFolders: SyncFolderMapping[];
  /** Obsidian 目录树缓存 */
  cachedObsidianFolders: { path: string; label: string }[];
  /** Trilium 目录树缓存 */
  cachedTriliumFolders: { path: string; noteId: string }[];
  /** 首次启用插件的时间戳（启用前的旧文件不同步） */
  startTime: number;
  /** 待同步的文件路径列表（用于退出中断后补同步） */
  pendingSyncFiles: string[];
}

export const DEFAULT_SETTINGS: TriliumSyncSettings = {
  triliumUrl: '',
  etapiToken: '',
  autoSyncEnabled: false,
  syncIntervalSeconds: 60,
  syncFolders: [],
  cachedObsidianFolders: [],
  cachedTriliumFolders: [],
  startTime: 0,
  pendingSyncFiles: [],
};

// Trilium ETAPI 数据类型

export interface TriliumNote {
  noteId: string;
  title: string;
  type: 'text' | 'code' | 'file' | 'image' | 'search' | 'book' | 'relationMap' | 'render';
  mime?: string;
  isProtected: boolean;
  blobId: string;
  attributes: TriliumAttribute[];
  parentNoteIds: string[];
  childNoteIds: string[];
  parentBranchIds: string[];
  childBranchIds: string[];
  dateCreated: string;
  dateModified: string;
  utcDateCreated: string;
  utcDateModified: string;
}

export interface TriliumAttribute {
  attributeId: string;
  noteId: string;
  type: 'label' | 'relation';
  name: string;
  value: string;
  position: number;
  isInheritable: boolean;
  utcDateModified: string;
}

export interface TriliumBranch {
  branchId: string;
  noteId: string;
  parentNoteId: string;
  prefix: string;
  notePosition: number;
  isExpanded: boolean;
  utcDateModified: string;
}

// 创建 Note 请求
export interface CreateNoteRequest {
  parentNoteId: string;
  title: string;
  type: 'text' | 'code';
  content: string;
  /** MIME 类型，不传默认 'text/markdown' */
  mime?: string;
  notePosition?: number;
}

// 创建 Attribute 请求
export interface CreateAttributeRequest {
  noteId: string;
  type: string;  // 'label' | 'relation' 或未来新增的类型
  name: string;
  value: string;
  isInheritable?: boolean;
}

// id-map.json 条目
export interface IdMapEntry {
  noteId: string;
  title: string;
  syncedAt: string;  // ISO 时间
}

// id-map.json 整体结构
export type IdMap = Record<string, IdMapEntry>;  // key = Obsidian 文件路径

// data.json（目录树缓存）
export interface TreeCache {
  cachedAt: number;  // 时间戳
  tree: TreeNode[];
}

export interface TreeNode {
  noteId: string;
  title: string;
  type: string;
  children: TreeNode[];
}

