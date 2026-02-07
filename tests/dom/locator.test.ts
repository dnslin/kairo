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
});
