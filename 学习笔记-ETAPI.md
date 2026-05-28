# Trilium ETAPI 规范学习笔记

> 基于 https://docs.triliumnotes.org/rest-api/etapi/ 整理
> 最后更新：2026-04-30

---

## 一、认证方式

两种方式（设置页面 → ETAPI 启用后会生成 token）：

1. **Token 认证**：`Authorization: Bearer <token>`
2. **Basic 认证**：用户名 + ETAPI token 做 Basic Auth

---

## 二、核心 API 列表

### Notes 相关

| 方法 | 端点 | 用途 |
|------|------|------|
| POST | `/etapi/notes` | 创建 Note |
| GET | `/etapi/notes/{noteId}` | 获取 Note 元数据 |
| PATCH | `/etapi/notes/{noteId}` | 更新 Note 元数据（标题等） |
| DELETE | `/etapi/notes/{noteId}` | 删除 Note |
| GET | `/etapi/notes/{noteId}/content` | 获取 Note 内容 |
| PUT | `/etapi/notes/{noteId}/content` | 更新 Note 内容 |
| GET | `/etapi/notes` | 搜索 Notes |

### Attributes 相关（重点）

| 方法 | 端点 | 用途 |
|------|------|------|
| POST | `/etapi/attributes` | 创建属性（label 或 relation） |
| GET | `/etapi/attributes/{attributeId}` | 获取属性详情 |
| PATCH | `/etapi/attributes/{attributeId}` | 更新属性（只能改 value 和 position） |
| DELETE | `/etapi/attributes/{attributeId}` | 删除属性 |

### Branches 相关

| 方法 | 端点 | 用途 |
|------|------|------|
| POST | `/etapi/branches` | 创建分支（把 Note 放到树中某位置） |
| GET | `/etapi/branches/{branchId}` | 获取分支详情 |
| PATCH | `/etapi/branches/{branchId}` | 更新分支（prefix, notePosition） |
| DELETE | `/etapi/branches/{branchId}` | 删除分支 |

### 其他

| 方法 | 端点 | 用途 |
|------|------|------|
| GET | `/etapi/notes/history` | 获取最近变更历史 |
| POST | `/etapi/notes/{noteId}/revision` | 创建快照 |
| GET | `/etapi/notes/{noteId}/revisions` | 获取快照列表 |
| GET | `/etapi/calendar/days/{date}` | 获取/创建日记 Note |
| GET | `/etapi/inbox/{date}` | 获取收件箱 Note |
| POST | `/etapi/auth/login` | 用密码登录获取 token |
| GET | `/etapi/app-info` | 获取 App 信息 |
| PUT | `/etapi/create-backup` | 创建备份 |

---

## 三、创建 Note 详解（POST /etapi/notes）

**Request Body：**
```json
{
  "parentNoteId": "root",        //required, 目标父 Note 的 noteId，"root"表示根节点
  "title": "笔记标题",           //required
  "type": "text",               //required, "text"|"code"|"file"|"image"|"search"|"book"|"relationMap"|"render"
  "mime": "text/html",          //仅 type="code" 时需要
  "content": "# 标题\\n内容",    //required, Note 的文本内容
  "notePosition": 10,           //在父节点中的位置，默认 10, 20, 30...
  "isExpanded": false,
  "noteId": "自定义ID",         //可选，不提供则自动生成
  "branchId": "自定义ID"        //可选
}
```

**Response 201：**
```json
{
  "note": {
    "noteId": "xxx",
    "title": "...",
    "type": "text",
    "attributes": [],
    "parentNoteIds": ["xxx"],
    "childNoteIds": [],
    "dateCreated": "2026-04-30 12:00:00.000+0800",
    "utcDateCreated": "2026-04-30T04:00:00.000Z",
    "utcDateModified": "2026-04-30T04:00:00.000Z"
  },
  "branch": {
    "branchId": "xxx",
    "noteId": "xxx",
    "parentNoteId": "xxx",
    "notePosition": 10
  }
}
```

---

## 四、Attributes 属性系统详解（最重要）

### 两种属性类型

- **label（拥有的属性）**：键值对，用于给 Note 打标签/属性
- **relation（关系）**：Note 之间的关联

### 创建属性（POST /etapi/attributes）

```json
{
  "noteId": "目标Note的ID",   //required
  "type": "label",            //required, "label" | "relation"
  "name": "dateNote",         //required, 属性名
  "value": "2026-04-30",      //required, 属性值
  "position": 0,
  "isInheritable": false
}
```

**Response 201：**
```json
{
  "attributeId": "xxx",
  "noteId": "xxx",
  "type": "label",
  "name": "dateNote",
  "value": "2026-04-30",
  "position": 0,
  "isInheritable": false
}
```

### 更新属性（PATCH /etapi/attributes/{attributeId}）

**只能更新 value 和 position**，其他字段改了不会生效。

如果需要改 name 或 type，必须 DELETE 后重建。

### 删除属性（DELETE /etapi/attributes/{attributeId})

---

## 五、dateNote 属性正确写入方式

根据设计方案，当文件一级目录为 `01-每日一志` 时，需要给 Note 添加 `dateNote` label。

**操作步骤：**

1. **创建 Note**（POST /etapi/notes）
2. **添加 dateNote 属性**（POST /etapi/attributes）
   ```json
   {
     "noteId": "<刚创建的Note的noteId>",
     "type": "label",
     "name": "dateNote",
     "value": "2026-04-30"
   }
   ```

**注意：** 这里是 `type: "label"` 不是 `type: "attribute"`！ETAPI 里没有单独的 "owned attribute" 端点，`postAttribute` 接口本身就是创建 label（拥有的属性）和 relation 的唯一途径。Trilium 界面里看到的"拥有的属性"对应 ETAPI 就是 type="label"。

---

## 六、更新 Note 内容（PUT /etapi/notes/{noteId}/content）

```
PUT /etapi/notes/{noteId}/content
Content-Type: text/plain

这是新的笔记内容
```

Response 204，无body。

---

## 七、更新 Note 元数据（PATCH /etapi/notes/{noteId}）

可以更新：title, type, mime, dateCreated, dateModified 等。

注意：attributes 数组是整体替换，不是增量追加。

---

## 八、搜索 Notes（GET /etapi/notes）

Query 参数：
- `search`: 搜索关键词，支持 `#labelName` 搜索标签
- `ancestorNoteId`: 限制在某个 Note 的子树中搜索
- `limit`: 限制结果数量
- `orderBy`: 排序字段

---

## 九、获取目录树/Tree 结构

**关键发现：** ETAPI 没有直接的"获取整个树"接口。需要组合：

1. `GET /etapi/notes/{noteId}` 获取某个 Note 的直接子节点（childNoteIds）
2. 递归获取子树

**实际同步策略：**
- 首次同步时，递归获取 Trilium 的目录树，缓存到 `data.json`
- 后续同步只需查 `id-map.json` 比对路径，不需要重查整棵树

---

## 十、删除 Note 的正确方式

`DELETE /etapi/notes/{noteId}` — 注意这是软删除还是硬删除看设置。ETAPI 返回 204 表示成功。

---

## 十一、postBranch — 在指定位置创建 Note

如果要把 Note 放到特定父节点下，需要：

1. 先 `POST /etapi/notes` 创建 Note（parentNoteId 设为目标父节点）
2. 自动就会创建 branch

---

## 十二、注意事项

1. **ETAPI Token**：从 Trilium 设置页面生成，有效期和配置有关
2. **CORS**：如果从浏览器直接调用，需要 Trilium 配置 CORS 白名单
3. **Note 保护**：受保护的 Note 无法通过 ETAPI 修改（返回 NOTE_IS_PROTECTED）
4. **Rate Limit**：认证失败太多次会触发限流（429）
5. **parentNoteId="root"**：表示根节点

---

## 十三、Obsidian 插件中调用 ETAPI 的方式

由于 Obsidian 插件运行在 Electron/浏览器环境中，建议在插件中用 `fetch` 调用 ETAPI：

```typescript
async function triliumRequest(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: object | string
): Promise<Response> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
  
  const options: RequestInit = { method, headers };
  
  if (body !== undefined) {
    if (typeof body === 'string') {
      headers['Content-Type'] = 'text/plain';
      options.body = body;
    } else {
      options.body = JSON.stringify(body);
    }
  }
  
  return fetch(`${baseUrl}/etapi${path}`, options);
}
```

---

## 十四、关键类型定义（TypeScript）

```typescript
interface TriliumNote {
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

interface TriliumAttribute {
  attributeId: string;
  noteId: string;
  type: 'label' | 'relation';
  name: string;
  value: string;
  position: number;
  isInheritable: boolean;
  utcDateModified: string;
}

interface TriliumBranch {
  branchId: string;
  noteId: string;
  parentNoteId: string;
  prefix: string;
  notePosition: number;
  isExpanded: boolean;
  utcDateModified: string;
}
```
