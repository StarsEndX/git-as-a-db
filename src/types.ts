// 数据类型定义

// 数据节点：支持任意 JSON 兼容值
// 使用 unknown 的宽松版本，因为数据同步库无法预知具体 schema
export type DataNode = Record<string, unknown> | unknown[] | string | number | boolean | null;

// 操作类型
export type OperationType = 'create' | 'update' | 'delete';
