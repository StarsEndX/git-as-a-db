import { Git, CommitMetadata, sortObjectKeys } from './git.js';
import { DataNode, OperationType } from './types.js';

const DATA_FILE = 'data.json';

// 数据管理器：每个操作直接修改 data.json 并 commit
// 注意：同一个 DataManager 实例不应并发调用 set()/delete()，
// 因为 saveAndCommit 不是原子的（先写文件再 commit），并发会导致竞态
export class DataManager {
  private git: Git;
  private actorId: string;
  private data: DataNode = {};

  constructor(git: Git, actorId: string) {
    this.git = git;
    this.actorId = actorId;
  }

  // 初始化：从 data.json 加载数据
  async init(): Promise<void> {
    const content = await this.git.readFile(DATA_FILE);
    if (content) {
      try {
        this.data = JSON.parse(content);
      } catch (e) {
        console.warn(`Failed to parse ${DATA_FILE}, using empty object`);
        this.data = {};
      }
    }
  }

  // 获取数据（支持路径查询）
  get(path?: string[]): DataNode {
    if (!path || path.length === 0) return this.data;

    let current: unknown = this.data;
    for (const key of path) {
      if (current === undefined || current === null) return undefined as unknown as DataNode;
      if (typeof current !== 'object') return undefined as unknown as DataNode;
      current = (current as Record<string, unknown>)[key];
    }
    return current as DataNode;
  }

  // 创建/更新数据
  async set(targetPath: string[], value: DataNode): Promise<void> {
    // 判断操作类型（基于 in-memory 数据）
    const opType: OperationType = this.get(targetPath) === undefined ? 'create' : 'update';

    // 修改数据
    if (targetPath.length === 0) {
      this.data = value;
    } else {
      // 根级数据必须是对象才能进行路径遍历
      if (this.data === null || typeof this.data !== 'object' || Array.isArray(this.data)) {
        // 根级是非对象值（string/number/boolean/null），无法设置子路径
        // 自动升级为对象
        this.data = {};
      }

      // 确保父路径存在，处理 null 值
      let parent: Record<string, unknown> = this.data as Record<string, unknown>;
      for (let i = 0; i < targetPath.length - 1; i++) {
        const key = targetPath[i];
        // 修复 null bug：null 的 typeof 也是 'object'，需要显式检查
        if (parent[key] === undefined || parent[key] === null || typeof parent[key] !== 'object') {
          parent[key] = {};
        }
        parent = parent[key] as Record<string, unknown>;
      }
      parent[targetPath[targetPath.length - 1]] = value;
    }

    // 保存并 commit
    await this.saveAndCommit(opType, targetPath);
  }

  // 删除数据
  async delete(targetPath: string[]): Promise<void> {
    if (targetPath.length === 0) {
      this.data = {} as DataNode;
    } else {
      // 根级数据必须是对象才能进行路径遍历
      if (this.data === null || typeof this.data !== 'object' || Array.isArray(this.data)) {
        return;  // 根级是非对象值，无法删除子路径
      }

      // 遍历到父节点，处理 null 和非对象值
      let parent: Record<string, unknown> = this.data as Record<string, unknown>;
      for (let i = 0; i < targetPath.length - 1; i++) {
        const key = targetPath[i];
        // 修复 null bug + 非对象值 bug
        if (parent[key] === undefined || parent[key] === null || typeof parent[key] !== 'object') {
          return;  // 路径不存在或中间有非对象值，无法删除
        }
        parent = parent[key] as Record<string, unknown>;
      }

      // 检查目标 key 是否存在
      const targetKey = targetPath[targetPath.length - 1];
      if (!Object.hasOwn(parent, targetKey)) {
        return;  // 目标不存在，不 commit（避免空 commit 报错）
      }
      delete parent[targetKey];
    }

    // 保存并 commit
    await this.saveAndCommit('delete', targetPath);
  }

  // 同步：从 data.json 重新加载数据
  async sync(): Promise<void> {
    const content = await this.git.readFile(DATA_FILE);
    if (content) {
      try {
        this.data = JSON.parse(content);
      } catch (e) {
        console.warn(`Failed to parse ${DATA_FILE} during sync, using empty object`);
        this.data = {};
      }
    }
  }

  // 保存 data.json 并 commit
  private async saveAndCommit(operation: OperationType, targetPath: string[]): Promise<void> {
    // 写入 data.json（key 排序保证序列化稳定，减少不必要的 diff）
    const content = JSON.stringify(sortObjectKeys(this.data), null, 2);
    await this.git.writeFile(DATA_FILE, content);

    // 构建 commit message
    const pathStr = targetPath.length > 0 ? targetPath.join('.') : '(root)';
    const message = `${operation}: ${pathStr}`;

    // commit（带元数据）
    const metadata: CommitMetadata = {
      actorId: this.actorId,
      operation,
      path: targetPath,
    };

    try {
      await this.git.commit(message, metadata);
    } catch (error: any) {
      // 写入相同值时 git 检测到 clean tree，视为 no-op（数据已正确）
      // 匹配 git 的两种错误信息："No changes to commit"（我们自己抛的）
      // 和 "nothing to commit"（git 原生的）
      const msg = error.message?.toLowerCase() || '';
      if (msg.includes('no changes to commit') || msg.includes('nothing to commit')) {
        return;
      }
      throw error;
    }
  }

  // 获取 actorId
  getActorId(): string {
    return this.actorId;
  }

  // 获取原始数据对象
  getRawData(): DataNode {
    return this.data;
  }
}
