import { createHash } from 'node:crypto';
import type {
  KK9FileInfo,
  KK9ImageInfo,
  KK9MentionInfo,
  KK9Message,
  KK9MessageOrigin,
  KK9MessageType,
  KK9RecalledEvent,
  KK9ReplyInfo,
  KK9Session,
} from '../types/index.js';

/**
 * 安全转为字符串，防止 [object Object] 隐式序列化
 */
export function toSafeString(val: unknown, defaultVal = ''): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') {
    return val.toString();
  }
  return defaultVal;
}

/**
 * 尝试解析 JSON 字符串
 */
function tryParseJson(val: unknown): Record<string, unknown> | null {
  if (!val) return null;
  if (typeof val === 'object') return val as Record<string, unknown>;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        const res = JSON.parse(trimmed) as unknown;
        if (res && typeof res === 'object') return res as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 计算消息唯一 SHA-256 指纹
 */
export function generateMessageFingerprint(
  sessionId: string,
  sender: string,
  time: string,
  content: string
): string {
  const raw = `${sessionId}\x00${sender}\x00${time}\x00${content}`;
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * 提取文本内容辅助函数
 */
function extractTextContent(content: unknown, notifyMsg?: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj['text'] === 'string') return obj['text'];
    if (typeof obj['msg'] === 'string') return obj['msg'];
    if (typeof obj['content'] === 'string') return obj['content'];
    try {
      return JSON.stringify(content);
    } catch {
      return toSafeString(content);
    }
  }
  if (typeof notifyMsg === 'string' && notifyMsg.trim()) {
    return notifyMsg;
  }
  return '';
}

/**
 * 判断消息类型
 */
function determineMessageType(
  raw: Record<string, unknown>,
  images?: KK9ImageInfo[],
  fileInfo?: KK9FileInfo,
  replyTo?: KK9ReplyInfo
): KK9MessageType {
  if (typeof raw['messageType'] === 'string') {
    return raw['messageType'] as KK9MessageType;
  }
  if (raw['contentType'] === 2 || raw['contentType'] === 'image' || (images && images.length > 0)) {
    return 'image';
  }
  if (raw['contentType'] === 3 || raw['contentType'] === 'file' || fileInfo) {
    return 'file';
  }
  if (replyTo || raw['replyMsg']) {
    return 'quote';
  }
  if (raw['richText'] || raw['html'] || raw['contentType'] === 'rich-text') {
    return 'rich-text';
  }
  if (raw['isSystem'] || raw['system'] || raw['contentType'] === 'system') {
    return 'system';
  }
  return 'text';
}
/**
 * 确定性判定消息来源身份 (origin)
 * 严格基于可观测 KK Payload、本地登录身份与已发送状态，不使用模型或概率推理
 */
export function determineOrigin(
  raw: Record<string, unknown>,
  isMe: boolean,
  messageType: KK9MessageType,
  context?: {
    currentUserId?: string | number;
    knownBotSentIds?: Set<string>;
    isBotEcho?: boolean;
  },
  id?: string
): KK9MessageOrigin {
  // 1. 系统消息判定
  if (
    messageType === 'system' ||
    raw['isSystem'] === true ||
    raw['system'] === true ||
    raw['systemMsg'] === true ||
    raw['sysType'] !== undefined ||
    raw['type'] === 'system' ||
    raw['msgType'] === 99 ||
    raw['contentType'] === 99
  ) {
    return 'system';
  }

  // 2. 当前账号发出的消息
  if (isMe) {
    const rawNativeId = raw['msgID'] ?? raw['msgId'] ?? raw['messageId'] ?? raw['id'];
    const nativeIdStr = rawNativeId !== undefined ? toSafeString(rawNativeId) : undefined;
    const isBot = Boolean(
      context?.isBotEcho ||
      (id && context?.knownBotSentIds?.has(id)) ||
      (nativeIdStr && context?.knownBotSentIds?.has(nativeIdStr))
    );
    if (isBot) {
      return 'bot_echo';
    }
    // 非 Bot 回显 -> 人类操作员在客户端打字/介入
    return 'operator';
  }

  // 3. 外部普通成员
  return 'external';
}

/**
 * 检查单条消息是否属于撤回事件载荷
 */
function isCancelMessageItem(item: Record<string, unknown>): boolean {
  if (
    item['event'] === 'CancelMessage' ||
    item['type'] === 'CancelMessage' ||
    item['msgFlag'] === 'C' ||
    item['msgFlag'] === 'D'
  ) {
    return true;
  }
  const contentObj = tryParseJson(item['content']);
  if (
    contentObj &&
    (contentObj['event'] === 'CancelMessage' || contentObj['type'] === 'CancelMessage')
  ) {
    return true;
  }
  return false;
}

/**
 * 将原生/底层事件载荷转换为标准的 KK9Message 数组
 */
export function normalizeNativeMessage(
  payload: unknown,
  context?: {
    session?: Partial<KK9Session>;
    currentUserId?: string | number;
    knownBotSentIds?: Set<string>;
    isBotEcho?: boolean;
  }
): KK9Message[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const rawObj = payload as Record<string, unknown>;

  // 1. 解析嵌套的会话信息
  const sessionObj = (
    rawObj['session'] && typeof rawObj['session'] === 'object' ? rawObj['session'] : {}
  ) as Record<string, unknown>;

  const rawSessionId =
    rawObj['sessionId'] ??
    rawObj['sessionID'] ??
    rawObj['sesUUID'] ??
    sessionObj['id'] ??
    sessionObj['sesUUID'] ??
    context?.session?.id;
  const sessionId = toSafeString(rawSessionId, '');

  const rawSessionName =
    rawObj['sessionName'] ??
    sessionObj['name'] ??
    sessionObj['typeName'] ??
    sessionObj['createrName'] ??
    context?.session?.name;
  const sessionName = toSafeString(rawSessionName, sessionId || '未知会话');

  const isGroup =
    rawObj['sessionType'] === 'group' ||
    sessionObj['type'] === 1 ||
    sessionObj['sessionType'] === 1 ||
    sessionObj['type'] === 'group' ||
    context?.session?.type === 'group';

  const sessionType = isGroup ? 'group' : 'private';

  // 2. 提取消息列表（可能是单条对象或消息数组）
  let rawList: Array<Record<string, unknown>> = [];
  if (Array.isArray(rawObj['messages'])) {
    rawList = rawObj['messages'] as Array<Record<string, unknown>>;
  } else if (Array.isArray(rawObj['message'])) {
    rawList = rawObj['message'] as Array<Record<string, unknown>>;
  } else if (rawObj['message'] && typeof rawObj['message'] === 'object') {
    rawList = [rawObj['message'] as Record<string, unknown>];
  } else if (Array.isArray(rawObj['data'])) {
    rawList = rawObj['data'] as Array<Record<string, unknown>>;
  } else if (rawObj['data'] && typeof rawObj['data'] === 'object') {
    rawList = [rawObj['data'] as Record<string, unknown>];
  } else if (Array.isArray(payload)) {
    rawList = payload as Array<Record<string, unknown>>;
  } else {
    rawList = [rawObj];
  }
  const now = Date.now();
  const currentUserId =
    context?.currentUserId !== undefined ? toSafeString(context.currentUserId) : null;

  return rawList
    .filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === 'object' && !isCancelMessageItem(item)
    )
    .map(item => {
      const rawSender =
        item['sender'] ??
        item['senderName'] ??
        item['sendName'] ??
        item['fromUserName'] ??
        (item['isMe'] ? '我' : '未知用户');
      const sender = toSafeString(rawSender, '未知用户');

      const rawSenderId = item['senderId'] ?? item['senderID'] ?? item['fromUID'];
      const senderId = rawSenderId !== undefined ? toSafeString(rawSenderId) : undefined;

      const content = extractTextContent(item['content'], item['notifyMsg']);
      const rawTime = item['time'] ?? item['sendTime'];
      const time = toSafeString(rawTime, new Date(now).toLocaleTimeString());

      const isMe = Boolean(
        item['isMe'] === true ||
        item['fromMe'] === true ||
        (currentUserId && senderId && senderId === currentUserId) ||
        (currentUserId && sender === currentUserId)
      );

      // 时间戳处理（秒级转毫秒级兼容）
      let timestamp = now;
      if (typeof item['timestamp'] === 'number') {
        timestamp = item['timestamp'] < 10000000000 ? item['timestamp'] * 1000 : item['timestamp'];
      } else if (typeof item['sendTime'] === 'number') {
        timestamp = item['sendTime'] < 10000000000 ? item['sendTime'] * 1000 : item['sendTime'];
      }

      // @ 提及信息解析
      let atMe = Boolean(
        item['atMe'] || item['isAtMe'] || item['atState'] === 1 || item['atState'] === 2
      );
      let atAll = Boolean(
        item['atAll'] ||
        item['isAtAll'] ||
        item['atState'] === 3 ||
        content.includes('@全体') ||
        content.includes('@所有人')
      );

      const atMemberList = Array.isArray(item['atMemberIDList']) ? item['atMemberIDList'] : [];
      if (
        atMemberList.includes('all') ||
        atMemberList.includes(-1) ||
        atMemberList.includes('-1')
      ) {
        atAll = true;
      }
      if (
        currentUserId &&
        (atMemberList.includes(currentUserId) || atMemberList.includes(Number(currentUserId)))
      ) {
        atMe = true;
      }

      let mentions: KK9MentionInfo | undefined;
      if (atMe || atAll || atMemberList.length > 0) {
        mentions = {
          isAtMe: atMe,
          isAtAll: atAll,
          mentionedUsers: atMemberList.map(u => toSafeString(u)),
        };
      }

      // 引用回复解析
      let replyTo: KK9ReplyInfo | undefined;
      if (item['replyTo'] && typeof item['replyTo'] === 'object') {
        replyTo = item['replyTo'] as KK9ReplyInfo;
      } else if (item['replyMsg'] && typeof item['replyMsg'] === 'object') {
        const r = item['replyMsg'] as Record<string, unknown>;
        replyTo = {
          replyToSender: toSafeString(r['sender'] ?? r['senderName'] ?? r['replyToSender'], ''),
          replyToContent: toSafeString(r['content'] ?? r['text'] ?? r['replyToContent'], ''),
          replyToId:
            (r['id'] ?? r['replyToId']) ? toSafeString(r['id'] ?? r['replyToId']) : undefined,
        };
      }

      // 图片附件解析
      let images: KK9ImageInfo[] | undefined;
      if (Array.isArray(item['images'])) {
        images = item['images'] as KK9ImageInfo[];
      } else if (item['picPath'] || item['imgUrl'] || item['picUrl']) {
        images = [
          {
            filePath: item['picPath'] ? toSafeString(item['picPath']) : undefined,
            url: item['imgUrl']
              ? toSafeString(item['imgUrl'])
              : item['picUrl']
                ? toSafeString(item['picUrl'])
                : undefined,
            width: typeof item['width'] === 'number' ? item['width'] : undefined,
            height: typeof item['height'] === 'number' ? item['height'] : undefined,
          },
        ];
      }

      // 文件附件解析
      let fileInfo: KK9FileInfo | undefined;
      if (item['fileInfo'] && typeof item['fileInfo'] === 'object') {
        fileInfo = item['fileInfo'] as KK9FileInfo;
      } else if (item['fileName'] || item['filePath']) {
        const fileName = toSafeString(item['fileName'], '未知文件');
        const extMatch =
          fileName.lastIndexOf('.') !== -1 ? fileName.slice(fileName.lastIndexOf('.')) : undefined;
        fileInfo = {
          fileName,
          fileSize:
            typeof item['fileSize'] === 'string'
              ? item['fileSize']
              : typeof item['fileSizeFormatted'] === 'string'
                ? item['fileSizeFormatted']
                : item['fileSize'] !== undefined
                  ? toSafeString(item['fileSize'])
                  : undefined,
          fileExt: typeof item['fileExt'] === 'string' ? item['fileExt'] : extMatch,
          filePath: typeof item['filePath'] === 'string' ? item['filePath'] : undefined,
        };
      }

      const messageType = determineMessageType(item, images, fileInfo, replyTo);

      // 指纹与原生 ID 解析（EventBridge 与 Polling 保证稳定一致）
      const fingerprint = generateMessageFingerprint(sessionId, sender, time, content);
      const rawNativeId = item['msgID'] ?? item['msgId'] ?? item['messageId'] ?? item['id'];
      const messageId = rawNativeId !== undefined ? toSafeString(rawNativeId) : fingerprint;
      const id = messageId || fingerprint;

      const origin = determineOrigin(item, isMe, messageType, context, id);

      return {
        id,
        messageId,
        sessionId,
        sessionName,
        sessionType,
        origin,
        sender,
        senderId,
        content,
        time,
        isMe,
        timestamp,
        messageType,
        atMe: atMe || undefined,
        atAll: atAll || undefined,
        mentions,
        replyTo,
        fileInfo,
        images,
        raw: item,
      };
    });
}
/**
 * 从任何事件载荷（receive-message, session-msg, direct payload）中提取所有撤回事件
 */
export function extractRecalledEventsFromPayload(
  payload: unknown,
  sessionContext?: Partial<KK9Session>
): KK9RecalledEvent[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const rawObj = payload as Record<string, unknown>;
  const events: KK9RecalledEvent[] = [];

  const rawSessionId =
    rawObj['sessionId'] ??
    rawObj['sessionID'] ??
    rawObj['sesUUID'] ??
    (rawObj['session'] as Record<string, unknown> | undefined)?.['id'] ??
    (rawObj['session'] as Record<string, unknown> | undefined)?.['sesUUID'] ??
    sessionContext?.id;
  const defaultSessionId = toSafeString(rawSessionId, '');

  // 1. 顶层直接包含 CancelMessage / recalled / messageId 载荷
  if (
    rawObj['messageId'] ||
    rawObj['msgID'] ||
    rawObj['event'] === 'CancelMessage' ||
    rawObj['type'] === 'CancelMessage' ||
    rawObj['type'] === 'recalled' ||
    rawObj['type'] === 'revokeMsg'
  ) {
    const rawId = rawObj['messageId'] ?? rawObj['msgID'] ?? rawObj['msgId'] ?? rawObj['id'];
    const messageId = toSafeString(rawId, '');
    if (messageId) {
      events.push({
        messageId,
        sessionId: defaultSessionId,
        sender: toSafeString(
          rawObj['sender'] ?? rawObj['senderName'] ?? rawObj['fromUserName'],
          '某人'
        ),
        time: toSafeString(rawObj['time'], new Date().toLocaleTimeString()),
        timestamp: typeof rawObj['timestamp'] === 'number' ? rawObj['timestamp'] : Date.now(),
      });
    }
  }

  // 2. 检查 payload 中的 messages / message 数组或内部字段
  let rawList: Array<Record<string, unknown>> = [];
  if (Array.isArray(rawObj['messages'])) {
    rawList = rawObj['messages'] as Array<Record<string, unknown>>;
  } else if (Array.isArray(rawObj['message'])) {
    rawList = rawObj['message'] as Array<Record<string, unknown>>;
  } else if (rawObj['message'] && typeof rawObj['message'] === 'object') {
    rawList = [rawObj['message'] as Record<string, unknown>];
  } else if (Array.isArray(payload)) {
    rawList = payload as Array<Record<string, unknown>>;
  }

  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const contentObj = tryParseJson(item['content']);
    if (
      contentObj &&
      (contentObj['event'] === 'CancelMessage' || contentObj['type'] === 'CancelMessage')
    ) {
      const rawId =
        contentObj['msgID'] ??
        contentObj['msgId'] ??
        contentObj['id'] ??
        item['msgID'] ??
        item['id'];
      const messageId = toSafeString(rawId, '');
      if (messageId) {
        events.push({
          messageId,
          sessionId: toSafeString(item['sessionID'] ?? item['sessionId'] ?? defaultSessionId),
          sender: toSafeString(
            item['sender'] ?? item['senderName'] ?? contentObj['sender'],
            '某人'
          ),
          time: toSafeString(item['time'] ?? item['sendTime'], new Date().toLocaleTimeString()),
          timestamp: typeof item['timestamp'] === 'number' ? item['timestamp'] : Date.now(),
        });
      }
    } else if (item['event'] === 'CancelMessage' || item['type'] === 'CancelMessage') {
      const rawId = item['msgID'] ?? item['msgId'] ?? item['id'];
      const messageId = toSafeString(rawId, '');
      if (messageId) {
        events.push({
          messageId,
          sessionId: toSafeString(item['sessionID'] ?? item['sessionId'] ?? defaultSessionId),
          sender: toSafeString(item['sender'] ?? item['senderName'], '某人'),
          time: toSafeString(item['time'] ?? item['sendTime'], new Date().toLocaleTimeString()),
          timestamp: typeof item['timestamp'] === 'number' ? item['timestamp'] : Date.now(),
        });
      }
    }
  }

  return events;
}

/**
 * 将原生撤回载荷解析为标准的 KK9RecalledEvent
 */
export function normalizeRecalledEvent(payload: unknown): KK9RecalledEvent | null {
  const events = extractRecalledEventsFromPayload(payload);
  return events[0] ?? null;
}
