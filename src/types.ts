// 操作类型定义
export interface Operation {
  id: string;                    // 唯一ID: timestamp-actorId-random
  timestamp: number;             // 本地时间戳（毫秒）
  actorId: string;               // 操作者ID
  causality: string[];           // 依赖的操作ID列表（向量时钟简化版）
  type: 'create' | 'update' | 'delete';
  path: string[];                // JSON Path，如 ['users', 'user1', 'name']
  value?: any;                   // 创建/更新时的值
}

// 同步状态
export interface SyncState {
  lastSyncTime: number;          // 最后同步时间
  lastOps: Map<string, number>;  // 每个actor的最后操作时间
}

// 冲突记录
export interface Conflict {
  operation: Operation;
  existingValue?: any;
  reason: string;
}
