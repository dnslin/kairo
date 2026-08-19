import { createHash } from 'node:crypto';
import type {
  KK9FileInfo,
  KK9ImageInfo,
  KK9MentionInfo,
  KK9Message,
  KK9MessageType,
  KK9RecalledEvent,
  KK9ReplyInfo,
  KK9Session,
} from '../types/index.js';

/**
 * 安全转为字符串，防止 [object Object] 隐式序列化
 */
function toSafeString(val: unknown, defaultVal = ''): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') {
    return val.toString();
  }
  return defaultVal;
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
 * 将原生/底层事件载荷转换为标准的 KK9Message 数组
 */
export function normalizeNativeMessage(
  payload: unknown,
  context?: {
    session?: Partial<KK9Session>;
    currentUserId?: string | number;
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
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
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

      // 指纹与 ID 生成
      const fingerprint = generateMessageFingerprint(sessionId, sender, time, content);
      const rawId = item['id'] ?? item['msgID'] ?? item['msgId'] ?? fingerprint;
      const id = toSafeString(rawId, fingerprint);

      return {
        id,
        sessionId,
        sessionName,
        sessionType,
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
 * 将原生撤回载荷解析为标准的 KK9RecalledEvent
 */
export function normalizeRecalledEvent(payload: unknown): KK9RecalledEvent | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const raw = payload as Record<string, unknown>;
  const rawId = raw['messageId'] ?? raw['msgID'] ?? raw['msgId'] ?? raw['id'];
  const messageId = toSafeString(rawId, '');
  if (!messageId) {
    return null;
  }

  const rawSessionId =
    raw['sessionId'] ??
    raw['sessionID'] ??
    raw['sesUUID'] ??
    (raw['session'] as Record<string, unknown> | undefined)?.['id'];
  const sessionId = toSafeString(rawSessionId, '');

  const rawSender = raw['sender'] ?? raw['senderName'] ?? raw['fromUserName'];
  const sender = toSafeString(rawSender, '某人');

  const rawTime = raw['time'];
  const time = toSafeString(rawTime, new Date().toLocaleTimeString());

  const timestamp = typeof raw['timestamp'] === 'number' ? raw['timestamp'] : Date.now();

  return {
    messageId,
    sessionId,
    sender,
    time,
    timestamp,
  };
}
