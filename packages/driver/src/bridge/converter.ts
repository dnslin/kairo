import type {
  KK9FileInfo,
  KK9ImageInfo,
  KK9MentionInfo,
  KK9Message,
  KK9MessageOrigin,
  KK9MessageType,
  MessageDirection,
  KK9RecalledEvent,
  KK9ReplyInfo,
  KK9Session,
} from '../types/index.js';

export function toSafeString(val: unknown, defaultVal = ''): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint') {
    return val.toString();
  }
  return defaultVal;
}

export function createMessageIdentityKey(sessionId: string, nativeMessageId: string): string {
  return `${sessionId.trim()}:${nativeMessageId.trim()}`;
}

export function tryParseJson(val: unknown): Record<string, unknown> | null {
  if (!val) return null;
  if (typeof val === 'object' && !Array.isArray(val)) return val as Record<string, unknown>;
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

function extractTextContent(content: unknown, notifyMsg?: unknown): string {
  if (typeof content === 'string') {
    const parsed = tryParseJson(content);
    if (parsed) return extractTextContent(parsed, notifyMsg);
    return content;
  }
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (obj['filename'] || obj['fileName']) {
      const fn = toSafeString(obj['filename'] || obj['fileName']);
      return `[文件: ${fn}]`;
    }
    if (Array.isArray(obj['content'])) {
      const text = obj['content']
        .map((c: unknown) => {
          if (c && typeof c === 'object') {
            const co = c as Record<string, unknown>;
            if (typeof co['text'] === 'string') return co['text'];
            if (co['type'] === 1) return '[图片]';
          }
          return '';
        })
        .filter(Boolean)
        .join('');
      if (text) return text;
    }
    if (typeof obj['text'] === 'string') return obj['text'];
    if (typeof obj['msg'] === 'string') return obj['msg'];
    if (typeof obj['content'] === 'string') return extractTextContent(obj['content']);
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

function determineMessageType(
  raw: Record<string, unknown>,
  images?: KK9ImageInfo[],
  fileInfo?: KK9FileInfo,
  replyTo?: KK9ReplyInfo
): KK9MessageType {
  if (typeof raw['messageType'] === 'string') {
    return raw['messageType'] as KK9MessageType;
  }
  if (fileInfo || raw['contentType'] === 3 || raw['contentType'] === 'file') {
    return 'file';
  }
  if (
    (images && images.length > 0) ||
    raw['contentType'] === 2 ||
    raw['contentType'] === 'image'
  ) {
    return 'image';
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

export function determineOrigin(
  raw: Record<string, unknown>,
  isMe: boolean,
  messageType: KK9MessageType,
  context?: {
    currentUserId?: string | number;
    knownBotSentMessageKeys?: Set<string>;
    isBotEcho?: boolean;
    sourceKnown?: boolean;
    sessionId?: string;
  },
  id?: string
): KK9MessageOrigin {
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

  const explicitOrigin = raw['origin'] ?? raw['source'];
  if (
    explicitOrigin === 'external' ||
    explicitOrigin === 'operator' ||
    explicitOrigin === 'bot_echo' ||
    explicitOrigin === 'system' ||
    explicitOrigin === 'unknown'
  ) {
    return explicitOrigin;
  }

  const rawNativeId = raw['msgID'] ?? raw['msgId'] ?? raw['messageId'] ?? raw['id'];
  const nativeIdStr = rawNativeId !== undefined ? toSafeString(rawNativeId).trim() : undefined;
  const botNativeId = id?.trim() || nativeIdStr;
  const messageKey =
    context?.sessionId && botNativeId
      ? createMessageIdentityKey(context.sessionId, botNativeId)
      : undefined;
  const isBot = Boolean(
    context?.isBotEcho || (messageKey && context?.knownBotSentMessageKeys?.has(messageKey))
  );
  if (isBot) {
    return 'bot_echo';
  }

  if (isMe) {
    return 'unknown';
  }

  if (context?.sourceKnown === false) {
    return 'unknown';
  }

  if (raw['isMe'] === false || raw['fromMe'] === false) {
    return 'external';
  }

  if (
    typeof raw['sender'] === 'string' &&
    raw['sender'] !== '未知' &&
    raw['sender'] !== '未知用户'
  ) {
    return 'external';
  }

  return 'unknown';
}

export type InboundNormalizationSource = 'event_bridge' | 'polling' | 'unknown';

export interface InboundNormalizationDiagnostic {
  kind: 'missing_inbound_identity';
  missingFields: readonly ('sessionId' | 'nativeMessageId')[];
  sessionId: string;
  source: InboundNormalizationSource;
  observedAt: number;
}

export interface NormalizeNativeMessageContext {
  session?: Partial<KK9Session>;
  currentUserId?: string | number;
  knownBotSentMessageKeys?: Set<string>;
  isBotEcho?: boolean;
  sourceKnown?: boolean;
  source?: InboundNormalizationSource;
  onDiagnostic?: (diagnostic: InboundNormalizationDiagnostic) => void;
}

function hasMessageBooleanFlag(
  raw: Record<string, unknown>,
  nestedRaw: Record<string, unknown> | undefined,
  key: 'isFromSelf' | 'fromMe' | 'isMe',
  value: boolean
): boolean {
  return raw[key] === value || nestedRaw?.[key] === value;
}

function isSystemMessageRecord(record: Record<string, unknown> | undefined): boolean {
  return (
    record?.['isSystem'] === true ||
    record?.['system'] === true ||
    record?.['systemMsg'] === true ||
    record?.['sysType'] !== undefined ||
    record?.['type'] === 'system' ||
    record?.['messageType'] === 'system' ||
    record?.['origin'] === 'system' ||
    record?.['source'] === 'system' ||
    record?.['msgType'] === 99 ||
    record?.['contentType'] === 99
  );
}

function hasRawMessageValue(
  raw: Record<string, unknown>,
  nestedRaw: Record<string, unknown> | undefined,
  key: 'origin' | 'source',
  value: KK9MessageOrigin
): boolean {
  return raw[key] === value || nestedRaw?.[key] === value;
}

function determineDirection(
  raw: Record<string, unknown>,
  nestedRaw: Record<string, unknown> | undefined,
  isMe: boolean,
  messageType: KK9MessageType,
  origin: KK9MessageOrigin,
  isKnownBotSentMessage: boolean,
  context: NormalizeNativeMessageContext | undefined,
  senderId: string | undefined
): MessageDirection {
  if (
    messageType === 'system' ||
    origin === 'system' ||
    isSystemMessageRecord(raw) ||
    isSystemMessageRecord(nestedRaw)
  ) {
    return 'unknown';
  }

  const currentUserId =
    context?.currentUserId !== undefined ? toSafeString(context.currentUserId).trim() : '';
  const nestedSenderId =
    nestedRaw?.['senderId'] ?? nestedRaw?.['senderID'] ?? nestedRaw?.['fromUID'];
  const observedSenderId = senderId?.trim() || toSafeString(nestedSenderId).trim();
  const senderIdMatchesCurrentUser = Boolean(
    currentUserId && observedSenderId && observedSenderId === currentUserId
  );
  const senderIdIsExternal = Boolean(
    currentUserId && observedSenderId && observedSenderId !== currentUserId
  );
  const hasSelfEvidence =
    isMe ||
    senderIdMatchesCurrentUser ||
    context?.isBotEcho === true ||
    isKnownBotSentMessage ||
    hasMessageBooleanFlag(raw, nestedRaw, 'isFromSelf', true) ||
    hasMessageBooleanFlag(raw, nestedRaw, 'fromMe', true) ||
    hasMessageBooleanFlag(raw, nestedRaw, 'isMe', true);

  if (hasSelfEvidence) {
    return 'outbound';
  }

  const hasExternalOrigin =
    hasRawMessageValue(raw, nestedRaw, 'origin', 'external') ||
    hasRawMessageValue(raw, nestedRaw, 'source', 'external');
  const hasOutboundOrigin =
    hasRawMessageValue(raw, nestedRaw, 'origin', 'operator') ||
    hasRawMessageValue(raw, nestedRaw, 'origin', 'bot_echo') ||
    hasRawMessageValue(raw, nestedRaw, 'source', 'operator') ||
    hasRawMessageValue(raw, nestedRaw, 'source', 'bot_echo');
  const hasExplicitNonSelfEvidence =
    senderIdIsExternal ||
    hasMessageBooleanFlag(raw, nestedRaw, 'isFromSelf', false) ||
    hasMessageBooleanFlag(raw, nestedRaw, 'fromMe', false) ||
    hasMessageBooleanFlag(raw, nestedRaw, 'isMe', false);

  if (hasExternalOrigin && hasOutboundOrigin) {
    return 'unknown';
  }
  if (hasExplicitNonSelfEvidence && hasOutboundOrigin) {
    return 'unknown';
  }
  if (hasExplicitNonSelfEvidence || hasExternalOrigin) {
    return 'inbound';
  }
  if (context?.sourceKnown === false) {
    return 'unknown';
  }
  if (hasOutboundOrigin) {
    return 'outbound';
  }
  return 'unknown';
}

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

export function normalizeNativeMessage(
  payload: unknown,
  context?: NormalizeNativeMessageContext
): KK9Message[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }

  const rawObj = payload as Record<string, unknown>;

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
  const sessionId = toSafeString(rawSessionId, '').trim();

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
    .map((item): KK9Message | null => {
      const rawSender =
        item['senderName'] ??
        item['sendName'] ??
        item['fromUserName'] ??
        item['sender'] ??
        (item['isMe'] ? '我' : '未知用户');
      const sender = toSafeString(rawSender, '未知用户');

      const rawSenderId =
        item['senderId'] ??
        item['senderID'] ??
        item['fromUID'] ??
        (typeof item['sender'] === 'number' ? item['sender'] : undefined);
      const senderId = rawSenderId !== undefined ? toSafeString(rawSenderId) : undefined;

      const contentObj =
        tryParseJson(item['content']) ||
        (typeof item['content'] === 'object'
          ? (item['content'] as Record<string, unknown>)
          : null);
      const content = extractTextContent(item['content'], item['notifyMsg']);
      const rawTime = item['time'] ?? item['sendTime'];
      const time = toSafeString(rawTime, new Date(now).toLocaleTimeString());

      const matchesCurrentUser = Boolean(
        currentUserId && ((senderId && senderId === currentUserId) || sender === currentUserId)
      );
      const sourceKnown =
        context?.sourceKnown ??
        (typeof item['isMe'] === 'boolean' ||
          typeof item['fromMe'] === 'boolean' ||
          Boolean(currentUserId && senderId));
      const isMe = Boolean(item['isMe'] === true || item['fromMe'] === true || matchesCurrentUser);

      let timestamp = now;
      const rawTs =
        item['timestamp'] ??
        item['sendTime'] ??
        item['msgTime'] ??
        item['createTime'] ??
        item['time'];
      if (typeof rawTs === 'number') {
        timestamp = rawTs < 10000000000 ? rawTs * 1000 : rawTs;
      } else if (typeof rawTs === 'string') {
        const parsed = Number(rawTs);
        if (!isNaN(parsed) && parsed > 0) {
          timestamp = parsed < 10000000000 ? parsed * 1000 : parsed;
        } else {
          const dateParsed = new Date(rawTs).getTime();
          if (!isNaN(dateParsed)) timestamp = dateParsed;
        }
      }

      const rawMentionsRecord =
        item['mentions'] && typeof item['mentions'] === 'object'
          ? (item['mentions'] as Record<string, unknown>)
          : null;
      const mentionedUsers = Array.isArray(rawMentionsRecord?.['mentionedUsers'])
        ? rawMentionsRecord['mentionedUsers'].filter(
            (user): user is string => typeof user === 'string'
          )
        : [];
      const rawMentions: KK9MentionInfo | undefined = rawMentionsRecord
        ? {
            isAtMe: rawMentionsRecord['isAtMe'] === true,
            isAtAll: rawMentionsRecord['isAtAll'] === true,
            mentionedUsers,
          }
        : undefined;
      let atMe = Boolean(
        item['atMe'] ||
        item['isAtMe'] ||
        rawMentions?.isAtMe ||
        item['atState'] === 2
      );
      let atAll = Boolean(
        item['atAll'] ||
        item['isAtAll'] ||
        rawMentions?.isAtAll ||
        item['atState'] === 3
      );

      const atMemberList = Array.isArray(item['atMemberIDList'])
        ? item['atMemberIDList']
        : (rawMentions?.mentionedUsers ?? []);
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

      let images: KK9ImageInfo[] | undefined;
      if (Array.isArray(item['images'])) {
        images = item['images'] as KK9ImageInfo[];
      } else if (contentObj && Array.isArray(contentObj['content'])) {
        const list = contentObj['content'] as Array<Record<string, unknown>>;
        const imgNodes = list.filter(
          c => c && (c['type'] === 1 || c['filepath'] || c['filepath_h'] || c['uri'])
        );
        if (imgNodes.length > 0) {
          images = imgNodes.map(c => {
            const fp = toSafeString(c['filepath'] || c['filepath_h']);
            return {
              filePath: fp || undefined,
              url: c['url']
                ? toSafeString(c['url'])
                : fp
                  ? 'file:///' + fp.replace(/\\/g, '/')
                  : undefined,
              uri: c['uri'] || c['uri_h'] ? toSafeString(c['uri'] || c['uri_h']) : undefined,
              mimeType: c['mimetype'] ? toSafeString(c['mimetype']) : 'image/png',
              width: typeof c['width'] === 'number' ? c['width'] : undefined,
              height: typeof c['height'] === 'number' ? c['height'] : undefined,
              size: typeof c['size'] === 'number' ? c['size'] : undefined,
            };
          });
        }
      } else if (item['picPath'] || item['imgUrl'] || item['picUrl']) {
        const fp = item['picPath'] ? toSafeString(item['picPath']) : undefined;
        images = [
          {
            filePath: fp,
            url: item['imgUrl']
              ? toSafeString(item['imgUrl'])
              : item['picUrl']
                ? toSafeString(item['picUrl'])
                : fp
                  ? 'file:///' + fp.replace(/\\/g, '/')
                  : undefined,
            width: typeof item['width'] === 'number' ? item['width'] : undefined,
            height: typeof item['height'] === 'number' ? item['height'] : undefined,
          },
        ];
      }

      let fileInfo: KK9FileInfo | undefined;
      if (item['fileInfo'] && typeof item['fileInfo'] === 'object') {
        fileInfo = item['fileInfo'] as KK9FileInfo;
      } else if (
        contentObj &&
        (contentObj['filename'] ||
          contentObj['fileName'] ||
          contentObj['filepath'] ||
          contentObj['filePath'])
      ) {
        const fileName = toSafeString(
          contentObj['filename'] || contentObj['fileName'],
          '未知文件'
        );
        const extMatch =
          fileName.lastIndexOf('.') !== -1 ? fileName.slice(fileName.lastIndexOf('.')) : undefined;
        fileInfo = {
          fileName,
          filePath: toSafeString(contentObj['filepath'] || contentObj['filePath']) || undefined,
          fileSize: toSafeString(contentObj['size'] || contentObj['fileSize']) || undefined,
          fileExt: extMatch,
        };
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

      const nestedRaw =
        item['raw'] && typeof item['raw'] === 'object'
          ? (item['raw'] as Record<string, unknown>)
          : undefined;
      const nativeMessageId =
        [
          item['msgID'],
          item['msgId'],
          item['messageId'],
          item['id'],
          nestedRaw?.['msgID'],
          nestedRaw?.['msgId'],
          nestedRaw?.['messageId'],
          nestedRaw?.['id'],
        ]
          .map(value => toSafeString(value).trim())
          .find(Boolean) ?? '';

      const missingFields: Array<'sessionId' | 'nativeMessageId'> = [];
      if (!sessionId) {
        missingFields.push('sessionId');
      }
      if (!nativeMessageId) {
        missingFields.push('nativeMessageId');
      }

      if (missingFields.length > 0) {
        context?.onDiagnostic?.({
          kind: 'missing_inbound_identity',
          missingFields,
          sessionId,
          source: context?.source ?? 'unknown',
          observedAt: Date.now(),
        });
        return null;
      }

      const origin = determineOrigin(
        item,
        isMe,
        messageType,
        { ...context, sourceKnown, sessionId },
        nativeMessageId
      );
      const isKnownBotSentMessage = Boolean(
        context?.isBotEcho ||
        context?.knownBotSentMessageKeys?.has(
          createMessageIdentityKey(sessionId, nativeMessageId)
        )
      );
      const direction = determineDirection(
        item,
        nestedRaw,
        isMe,
        messageType,
        origin,
        isKnownBotSentMessage,
        { ...context, sourceKnown },
        senderId
      );

      return {
        id: nativeMessageId,
        messageId: nativeMessageId,
        sessionId,
        sessionName,
        sessionType,
        origin,
        direction,
        sender,
        senderId,
        content,
        time,
        isMe,
        timestamp,
        messageType,
        atMe,
        atAll,
        mentions,
        replyTo,
        fileInfo,
        images,
        raw: item,
      };
    })
    .filter((msg): msg is KK9Message => msg !== null);
}

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

export function normalizeRecalledEvent(payload: unknown): KK9RecalledEvent | null {
  const events = extractRecalledEventsFromPayload(payload);
  return events[0] ?? null;
}
