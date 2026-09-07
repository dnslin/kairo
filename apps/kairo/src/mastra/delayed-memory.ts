import type { MastraDBMessage } from '@mastra/core/memory';
import type { Memory } from '@mastra/memory';

export interface MemoryDelivery {
  status: 'delivered' | 'failed' | 'cancelled' | 'timed_out' | 'unknown';
  taskId: string;
  threadId: string;
  resourceId: string;
  // 调用方传入已清洗的员工正文和实际送达正文，不接收模型响应或历史消息数组。
  userText: string;
  assistantText: string;
  deliveredAt: Date;
}

export async function commitDeliveredMemory(
  memory: Memory,
  delivery: MemoryDelivery
): Promise<void> {
  if (delivery.status !== 'delivered') return;
  const { threadId, resourceId, taskId } = delivery;
  const thread = await memory.getThreadById({ threadId });
  if (thread && thread.resourceId !== resourceId) {
    throw new Error('正式消息的员工身份与 thread 所属员工不一致');
  }
  if (!thread) await memory.createThread({ threadId, resourceId, title: '员工对话' });

  const messages: MastraDBMessage[] = [
    {
      id: JSON.stringify([threadId, taskId, 'user']),
      threadId,
      resourceId,
      role: 'user',
      // 正式记忆按送达轮次排序，不能沿用可能落在上一轮观察游标之前的入站时间。
      createdAt: new Date(delivery.deliveredAt.getTime() - 1),
      content: { format: 2, parts: [{ type: 'text', text: delivery.userText }] },
    },
    {
      id: JSON.stringify([threadId, taskId, 'assistant']),
      threadId,
      resourceId,
      role: 'assistant',
      createdAt: delivery.deliveredAt,
      content: { format: 2, parts: [{ type: 'text', text: delivery.assistantText }] },
    },
  ];
  await memory.saveMessages({ messages });
  const engine = await memory.omEngine;
  if (!engine) throw new Error('正式记忆未配置 Observational Memory');
  await engine.observe({ threadId, resourceId });
}
