# sync-lib

基于 Git 的结构化数据同步库。

## 核心设计

- **每个操作一个 commit**：每次 create/update/delete 直接生成一个 Git commit
- **数据存储**：`data.json` 文件存储所有数据
- **冲突解决**：
  - 不同路径：自动深度合并（JSON deep merge）
  - 相同路径：LWW（Last Write Wins），基于 commit timestamp
- **自动同步**：push 失败自动 pull + merge + retry

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

测试覆盖场景：
1. 基本操作（create/update/delete）
2. 单用户连续操作
3. 双用户并发（不同路径）- 深度合并
4. 双用户并发（相同路径）- LWW
5. 离线操作恢复
6. 多节点竞争
7. 轮询自动同步

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
