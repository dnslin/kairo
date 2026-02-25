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
        result: { value: true },
      });

      const result = await locator.selectSession('s1');

      expect(result).toBe(true);
      expect(connector.evaluate).toHaveBeenCalledTimes(1);
    });

    it('目标不在 DOM 中时滚动查找并点击', async () => {
      // Call 1: 直接查找 → 未找到，返回滚动信息
      connector.evaluate.mockResolvedValueOnce({
        result: {
          value: {
            found: false,
            scrollHeight: 960,
            clientHeight: 320,
            scrollTop: 0,
          },
        },
      });

      // Call 2: 滚动到 320
      connector.evaluate.mockResolvedValueOnce({ result: { value: 320 } });
      // Call 3: 查找 → 未找到
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { found: false, scrollTop: 320 } },
      });

      // Call 4: 滚动到 640
      connector.evaluate.mockResolvedValueOnce({ result: { value: 640 } });
      // Call 5: 查找 → 找到并点击
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { found: true } },
      });

      const result = await locator.selectSession('s-hidden');

      expect(result).toBe(true);
      // init + 2*(scroll+find) = 5
      expect(connector.evaluate).toHaveBeenCalledTimes(5);
    });

    it('滚动到底部仍未找到时返回 false', async () => {
      // Call 1: 直接查找 → 未找到
      connector.evaluate.mockResolvedValueOnce({
        result: {
          value: {
            found: false,
            scrollHeight: 640,
            clientHeight: 320,
            scrollTop: 0,
          },
        },
      });

      // Call 2: 滚动到 320
      connector.evaluate.mockResolvedValueOnce({ result: { value: 320 } });
      // Call 3: 查找 → 未找到
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { found: false, scrollTop: 320 } },
      });

      // Call 4: 恢复滚动位置
      connector.evaluate.mockResolvedValueOnce({
        result: { value: true },
      });

      const result = await locator.selectSession('not-exist');

      expect(result).toBe(false);
      // init + 1*(scroll+find) + restore = 4
      expect(connector.evaluate).toHaveBeenCalledTimes(4);
    });

    it('滚动查找失败后恢复原始滚动位置', async () => {
      // Call 1: 直接查找 → 未找到，scrollTop=100
      connector.evaluate.mockResolvedValueOnce({
        result: {
          value: {
            found: false,
            scrollHeight: 640,
            clientHeight: 320,
            scrollTop: 100,
          },
        },
      });

      // Call 2: 滚动到 420
      connector.evaluate.mockResolvedValueOnce({ result: { value: 420 } });
      // Call 3: 查找 → 未找到
      connector.evaluate.mockResolvedValueOnce({
        result: { value: { found: false, scrollTop: 420 } },
      });

      // Call 4: 恢复
      connector.evaluate.mockResolvedValueOnce({
        result: { value: true },
      });

      await locator.selectSession('not-exist');

      // 恢复是 calls[3]
      const lastCall = connector.evaluate.mock.calls[3]?.[0] as string;
      expect(lastCall).toContain('100');
    });

    it('evaluate 异常时返回 false', async () => {
      connector.evaluate.mockRejectedValueOnce(new Error('CDP断开'));

      const result = await locator.selectSession('s1');

      expect(result).toBe(false);
    });
  });
});
