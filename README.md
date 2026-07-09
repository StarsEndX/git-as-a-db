# sync-lib

基于 Git 的结构化数据同步库。

## 核心设计

- **每个操作一个 commit**：每次 create/update/delete 直接生成一个 Git commit
- **数据存储**：`data.json` 文件存储所有数据
- **冲突解决**：
  - 不同路径：自动深度合并（3-way merge）
  - 相同路径：LWW（Last Write Wins），基于 commit timestamp
  - 删除传播：一方删除、另一方未修改 → 删除生效；一方删除、另一方修改 → 修改方赢
- **自动同步**：push 失败自动 pull + merge + retry

## 已知局限

1. **并发写限制**：同一个 `DataManager` 实例不应并发调用 `set()`/`delete()`。`saveAndCommit` 不是原子的（先写文件再 commit），并发会导致竞态。需要并发时请使用锁或队列串行化。
2. **单文件存储**：所有数据存在一个 `data.json` 里。两个用户改完全不相关的路径也会产生 Git conflict（同一文件被两边修改），每次冲突都要解析整个文件。数据量大时性能会下降。
3. **无事务保证**：连续调用 `dm.set(['a'], 1)` 和 `dm.set(['b'], 2)` 会产生两个独立 commit。如果第二个失败，第一个已经 commit 成功，无法回滚。

## 架构

```
src/
  git.ts           Git 封装（基于 simple-git）
  data-manager.ts  数据管理（set/delete/get）
  sync-manager.ts  同步管理（push/pull/polling）
  types.ts         类型定义
  index.ts         导出
  test.ts          测试用例
```

## 测试

```bash
pnpm build
pnpm test
```

测试覆盖场景（16 个测试套件，59 个用例）：
1. 基本操作（create/update/delete，8 种数据类型）
2. null 值处理（null 后 set/delete 子路径不崩溃）
3. delete 不存在的路径（静默返回，不空 commit）
4. 路径边界（空路径、不存在路径、深层嵌套、非对象中间值）
5. 单用户连续操作 + CommitMetadata round-trip 验证
6. 双用户并发（不同路径）- 3-way 深度合并
7. 双用户并发（相同路径）- LWW（严格验证后提交者赢）
8. 3-way merge 删除传播（一方删除/双方删除/删除+修改，真正触发 merge）
9. 离线操作恢复
10. 多节点竞争（3 用户并发 push）
11. push 重试和错误处理（PushResult、重试后成功）
12. 轮询自动同步（含 start/stop 边界）
13. 工具函数（deepEqual/NaN/sortObjectKeys/Date）
14. JSON 解析容错（空文件/非法 JSON/文件不存在）
15. 操作类型判断（create/update/delete metadata）
16. 根级非对象数据保护（string/null/array 自动升级为对象）

## 使用示例

```typescript
import { SyncManager } from './sync-manager.js';

// 初始化
const sync = new SyncManager('/path/to/repo', 'user1');
await sync.init();

// 设置数据（自动 commit）
const dm = sync.getDataManager();
await dm.set(['users', 'user1'], { name: 'Alice', age: 30 });

// 推送到远程（自动处理并发）
await sync.push();

// 同步远程更新（自动处理冲突）
await sync.sync();

// 启动轮询自动同步
sync.startPolling();
```
