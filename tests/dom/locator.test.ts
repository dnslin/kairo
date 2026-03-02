import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DomLocator } from '../../src/dom/locator.js';
import type { CdpConnector } from '../../src/cdp/connector.js';
import type { SelectorsConfig } from '../../src/config/schema.js';
import type {
  MessageListInfo,
  MessageNodeInfo,
  MessageNodesInfo,
  SendButtonInfo,
} from '../../src/dom/locator.js';

type DraftDomLocator = {
  getMessageList: () => Promise<MessageListInfo>;
  getMessageNodes: () => Promise<MessageNodesInfo>;
  getSendButton: () => Promise<SendButtonInfo>;
};

const createMockConnector = () => ({
  evaluate: vi.fn(),
});

const createMockSelectors = (): SelectorsConfig => ({
  sessionList: '#session-list',
  sessionScroller: '.session-scroller',
  sessionItem: '.session-item',
  sessionItemSelected: '.session-item-selected',
  sessionName: '.session-name',
  sessionTime: '.session-time',
  sessionPreview: '.session-preview',
  sessionUnread: '.session-unread',
  groupAvatar: '.group-avatar',
  discussAvatar: '.discuss-avatar',
  privateAvatar: '.private-avatar',
  messageContainer: '.message-container',
  messageItem: '.message-item',
  messageContent: '.message-content',
  messageSender: '.message-sender',
  messageTime: '.message-time',
  messageLeft: '.message-left',
  messageRight: '.message-right',
  editorArea: '.editor-area',
  inputBox: '.input-box',
  sendButton: '.send-button',
});

describe('DomLocator', () => {
  let connector: ReturnType<typeof createMockConnector>;
  let selectors: SelectorsConfig;
  let locator: DomLocator;
  let draftLocator: DraftDomLocator;

  beforeEach(() => {
    connector = createMockConnector();
    selectors = createMockSelectors();
    locator = new DomLocator(connector as unknown as CdpConnector, selectors);
    draftLocator = locator as unknown as DraftDomLocator;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getMessageList', () => {
    it('元素存在时返回found=true', async () => {
      const expected: MessageListInfo = {
        found: true,
        selector: selectors.messageContainer,
        childCount: 3,
      };

      connector.evaluate.mockResolvedValue({ result: { value: expected } });

      const result = await draftLocator.getMessageList();

      expect(result).toEqual(expected);
    });

    it('元素不存在时返回found=false', async () => {
      const expected: MessageListInfo = {
        found: false,
        selector: selectors.messageContainer,
        childCount: 0,
      };

      connector.evaluate.mockResolvedValue({ result: { value: expected } });

      const result = await draftLocator.getMessageList();

      expect(result).toEqual(expected);
    });
  });

  describe('getMessageNodes', () => {
    it('返回count与节点数组', async () => {
      const nodes: MessageNodeInfo[] = [
        { id: 'msg-1', index: 0 },
        { id: 'msg-2', index: 1 },
      ];
      const expected: MessageNodesInfo = {
        found: true,
        selector: selectors.messageItem,
        count: nodes.length,
        nodes,
      };

      connector.evaluate.mockResolvedValue({ result: { value: expected } });

      const result = await draftLocator.getMessageNodes();

      expect(result).toEqual(expected);
    });

    it('没有消息时返回空节点', async () => {
      const expected: MessageNodesInfo = {
        found: true,
        selector: selectors.messageItem,
        count: 0,
        nodes: [],
      };

      connector.evaluate.mockResolvedValue({ result: { value: expected } });

      const result = await draftLocator.getMessageNodes();

      expect(result).toEqual(expected);
    });
  });

  describe('getSendButton', () => {
    it('返回found、visible与enabled', async () => {
      const expected: SendButtonInfo = {
        found: true,
        selector: selectors.sendButton,
        visible: true,
        enabled: true,
      };

      connector.evaluate.mockResolvedValue({ result: { value: expected } });

      const result = await draftLocator.getSendButton();

      expect(result).toEqual(expected);
    });

    it('按钮不存在时返回found=false', async () => {
      const expected: SendButtonInfo = {
        found: false,
        selector: selectors.sendButton,
        visible: false,
        enabled: false,
      };

      connector.evaluate.mockResolvedValue({ result: { value: expected } });

      const result = await draftLocator.getSendButton();

      expect(result).toEqual(expected);
    });
  });

  describe('getAllSessions', () => {
    /** 构造 SessionInfo 辅助函数 */
    function makeSession(
      id: string,
      name: string,
      type: 'private' | 'group' = 'private'
    ): {
      id: string;
      name: string;
      type: 'private' | 'group';
      lastMessage: string;
      time: string;
      unread: boolean;
      isSelected: boolean;
    } {
      return {
        id,
        name,
        type,
        lastMessage: '',
        time: '',
        unread: false,
        isSelected: false,
      };
    }

    it('从 Vue 实例获取全部会话', async () => {
      const sessions = [
        makeSession('s1', 'Alice'),
        makeSession('s2', 'Bob'),
        makeSession('s3', 'Charlie'),
      ];

      connector.evaluate.mockResolvedValueOnce({
        result: { value: { sessions } },
      });

      const result = await locator.getAllSessions({ scrollDelayMs: 0 });

      expect(result).toEqual(sessions);
      expect(connector.evaluate).toHaveBeenCalledTimes(1);
    });

    it('Vue 实例不可用时回退到 getSessions', async () => {
      // getAllSessions 返回 vueNotFound
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { vueNotFound: true } },
      });

      // 回退到 getSessions
      const sessions = [makeSession('s1', 'Alice')];
      connector.evaluate.mockResolvedValueOnce({
        result: { value: sessions },
      });

      const result = await locator.getAllSessions({ scrollDelayMs: 0 });

      expect(result).toEqual(sessions);
      expect(connector.evaluate).toHaveBeenCalledTimes(2);
    });

    it('滚动容器不存在时回退到 getSessions', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { scrollerNotFound: true } },
      });

      const sessions = [makeSession('s1', 'Alice')];
      connector.evaluate.mockResolvedValueOnce({
        result: { value: sessions },
      });

      const result = await locator.getAllSessions({ scrollDelayMs: 0 });

      expect(result).toEqual(sessions);
      expect(connector.evaluate).toHaveBeenCalledTimes(2);
    });

    it('evaluate 抛出异常时抛出 DomLocatorError', async () => {
      connector.evaluate.mockRejectedValueOnce(new Error('CDP断开'));

      await expect(locator.getAllSessions({ scrollDelayMs: 0 })).rejects.toThrow(
        'Failed to get all sessions'
      );
    });
  });

  describe('selectSession', () => {
    it('目标在当前 DOM 中时直接点击成功', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { found: true } },
      });

      const result = await locator.selectSession('s1');

      expect(result).toBe(true);
      expect(connector.evaluate).toHaveBeenCalledTimes(1);
    });

    it('通过 scrollToItem 滚动后点击成功', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { found: false, hasVue: true, index: 5 } },
      });
      connector.evaluate.mockResolvedValueOnce({
        result: { value: true },
      });
      connector.evaluate.mockResolvedValueOnce({
        result: { value: true },
      });

      const result = await locator.selectSession('s-hidden');

      expect(result).toBe(true);
      expect(connector.evaluate).toHaveBeenCalledTimes(3);
    });

    it('Vue 实例不可用时返回 false', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { found: false, hasVue: false } },
      });

      const result = await locator.selectSession('s1');

      expect(result).toBe(false);
      expect(connector.evaluate).toHaveBeenCalledTimes(1);
    });

    it('目标不在 Vue items 中时返回 false', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { found: false, hasVue: true, index: -1 } },
      });

      const result = await locator.selectSession('not-exist');

      expect(result).toBe(false);
      expect(connector.evaluate).toHaveBeenCalledTimes(1);
    });

    it('scrollToItem 后 DOM 中仍未找到时返回 false', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { found: false, hasVue: true, index: 3 } },
      });
      connector.evaluate.mockResolvedValueOnce({
        result: { value: true },
      });
      connector.evaluate.mockResolvedValueOnce({
        result: { value: false },
      });

      const result = await locator.selectSession('s-missing');

      expect(result).toBe(false);
      expect(connector.evaluate).toHaveBeenCalledTimes(3);
    });

    it('scrollToItem 调用失败时返回 false', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { found: false, hasVue: true, index: 2 } },
      });
      connector.evaluate.mockResolvedValueOnce({
        result: { value: false },
      });

      const result = await locator.selectSession('s-fail');

      expect(result).toBe(false);
      expect(connector.evaluate).toHaveBeenCalledTimes(2);
    });

    it('evaluate 异常时返回 false', async () => {
      connector.evaluate.mockRejectedValueOnce(new Error('CDP断开'));

      const result = await locator.selectSession('s1');

      expect(result).toBe(false);
    });
  });

  describe('getActiveSessionId', () => {
    it('返回当前选中会话的 ID', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: 'session-abc-123' },
      });

      const result = await locator.getActiveSessionId();

      expect(result).toBe('session-abc-123');
      expect(connector.evaluate).toHaveBeenCalledTimes(1);
    });

    it('无选中会话时返回 null', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: null },
      });

      const result = await locator.getActiveSessionId();

      expect(result).toBeNull();
    });

    it('evaluate 抛出异常时返回 null', async () => {
      connector.evaluate.mockRejectedValueOnce(new Error('CDP断开'));

      const result = await locator.getActiveSessionId();

      expect(result).toBeNull();
    });
  });

  describe('isMessageInDom', () => {
    it('匹配内容和发送者时返回 true', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: true },
      });

      const result = await locator.isMessageInDom('你好', '张三');

      expect(result).toBe(true);
      expect(connector.evaluate).toHaveBeenCalledTimes(1);
    });

    it('无匹配消息时返回 false', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: false },
      });

      const result = await locator.isMessageInDom('已删除的消息', '张三');

      expect(result).toBe(false);
    });

    it('evaluate 抛出异常时返回 false', async () => {
      connector.evaluate.mockRejectedValueOnce(new Error('CDP断开'));

      const result = await locator.isMessageInDom('你好', '张三');

      expect(result).toBe(false);
    });
  });

  describe('hasNewMessagesSince', () => {
    it('目标消息后有新消息时返回 true', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: true },
      });

      const result = await locator.hasNewMessagesSince('你好', '张三');

      expect(result).toBe(true);
      expect(connector.evaluate).toHaveBeenCalledTimes(1);
    });

    it('目标消息是最后一条非自己消息时返回 false', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: false },
      });

      const result = await locator.hasNewMessagesSince('你好', '张三');

      expect(result).toBe(false);
    });

    it('目标消息不存在时返回 false', async () => {
      connector.evaluate.mockResolvedValueOnce({
        result: { value: false },
      });

      const result = await locator.hasNewMessagesSince('不存在', '无人');

      expect(result).toBe(false);
    });

    it('evaluate 抛出异常时返回 false', async () => {
      connector.evaluate.mockRejectedValueOnce(new Error('CDP断开'));

      const result = await locator.hasNewMessagesSince('你好', '张三');

      expect(result).toBe(false);
    });
  });
});
