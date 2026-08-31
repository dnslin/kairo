import { runInNewContext } from 'node:vm';

export const NO_IPC_RESPONSE = Symbol('NO_IPC_RESPONSE');

export interface FakeIpcRequest {
  id: number;
  args: unknown[];
  progress?: boolean;
}

type FakeIpcResponder = (request: FakeIpcRequest) => unknown;
type FakeIpcListener = (_event: unknown, payload: unknown) => void;

export class FakeIpcRenderer {
  public readonly sent: FakeIpcRequest[] = [];
  private readonly listeners = new Map<string, FakeIpcListener[]>();

  constructor(private readonly responder: FakeIpcResponder) {}

  public once(channel: string, listener: FakeIpcListener): void {
    const listeners = this.listeners.get(channel) ?? [];
    listeners.push(listener);
    this.listeners.set(channel, listeners);
  }

  public removeAllListeners(channel: string): void {
    this.listeners.delete(channel);
  }

  public removeListener(channel: string, listener: FakeIpcListener): void {
    const listeners = this.listeners.get(channel);
    if (!listeners) return;

    const remaining = listeners.filter(candidate => candidate !== listener);
    if (remaining.length === 0) {
      this.listeners.delete(channel);
    } else {
      this.listeners.set(channel, remaining);
    }
  }

  public listenerCount(channel: string): number {
    return this.listeners.get(channel)?.length ?? 0;
  }

  public send(channel: string, request: FakeIpcRequest): void {
    if (channel !== 'data') return;

    this.sent.push(request);
    const response = this.responder(request);
    if (response === NO_IPC_RESPONSE) return;

    const replyChannel = `data-${request.id}`;
    const listeners = this.listeners.get(replyChannel) ?? [];
    this.listeners.delete(replyChannel);
    for (const listener of listeners) {
      listener(undefined, response);
    }
  }
}

export interface RendererSession extends Record<string, unknown> {
  id: string | number;
  sesUUID?: string;
  typeName?: string;
  name?: string;
  type?: number;
  typeID?: string | number;
  sesTypeID?: string | number;
  maxMessageIndex?: number;
  userReadIndex?: number;
  atState?: number;
}

export interface RendererMessage extends Record<string, unknown> {
  id?: string | number;
  msgID?: string | number;
  msgIdx?: number;
  sessionID?: string | number;
}

interface RendererRuntimeOptions {
  ipc?: FakeIpcRenderer;
  sessions?: RendererSession[];
  activeSession?: RendererSession | null;
  messages?: RendererMessage[];
  math?: Math;
  clipboardWrite?: (items: unknown[]) => Promise<void>;
  onSendClick?: () => void;
}

interface RendererEvent {
  event: string;
  args: unknown[];
}

interface RendererCommit {
  type: string;
  payload: unknown;
}

export interface RendererRuntime {
  context: Record<string, unknown>;
  editor: {
    activedSes: RendererSession | null;
    sortedSessions: RendererSession[];
  };
  events: RendererEvent[];
  commits: RendererCommit[];
}

class FakeClipboardItem {
  constructor(public readonly items: Record<string, unknown>) {}
}

class FakeMouseEvent {
  constructor(
    public readonly type: string,
    public readonly init?: Record<string, unknown>
  ) {}
}

export function createRendererRuntime(options: RendererRuntimeOptions = {}): RendererRuntime {
  const sessions = options.sessions ?? [];
  const editor = {
    activedSes: options.activeSession === undefined ? (sessions[0] ?? null) : options.activeSession,
    sortedSessions: sessions,
  };
  const events: RendererEvent[] = [];
  const commits: RendererCommit[] = [];
  const bus = {
    $emit(event: string, ...args: unknown[]): void {
      events.push({ event, args });
    },
  };
  const store = {
    commit(type: string, payload: unknown): void {
      commits.push({ type, payload });
    },
  };
  const main = {
    userID: 5761,
    userName: '我',
    deviceID: 'test-device',
    $bus: bus,
  };
  const app = { $bus: bus, $store: store };
  const editorNode = {
    __vue__: editor,
    focus(): void {},
  };
  const sendButton = {
    dispatchEvent(): boolean {
      return true;
    },
    click(): void {
      options.onSendClick?.();
    },
  };
  const messageNodes = (options.messages ?? []).map(message => {
    const id = message.id ?? message.msgID;
    return {
      id: id === undefined ? '' : String(id),
      __vue__: { msgitem: message },
      classList: {
        contains(): boolean {
          return false;
        },
      },
      matches(): boolean {
        return message['isMe'] === true || message['isFromSelf'] === true;
      },
      querySelector(selector: string): { textContent: string } | null {
        if (selector.includes('sender')) {
          const senderName = message['senderName'];
          return { textContent: typeof senderName === 'string' ? senderName : '' };
        }
        if (selector.includes('time')) {
          const time = message['time'];
          return { textContent: typeof time === 'string' ? time : '' };
        }
        return null;
      },
      getAttribute(name: string): string | null {
        if (name !== 'id' && name !== 'data-msg-id' && name !== 'data-id') return null;
        return id === undefined ? null : String(id);
      },
    };
  });

  const document = {
    querySelector(selector: string): unknown {
      if (selector === '#app') return { __vue__: app };
      if (selector.includes('.main-page')) return { __vue__: main };
      if (selector.includes('.sendMsg-btn')) return sendButton;
      if (
        selector.includes('.chat-editor') ||
        selector.includes('.message-editor') ||
        selector.includes('.chat-sendArea') ||
        selector.includes('[contenteditable]')
      ) {
        return editorNode;
      }
      return null;
    },
    querySelectorAll(selector: string): unknown[] {
      if (
        selector.includes('.rcd-item') ||
        selector.includes('.message-item') ||
        selector.includes('.msg-item')
      ) {
        return messageNodes;
      }
      return [];
    },
  };

  const windowObject: Record<string, unknown> = {
    focus(): void {},
    vueBus: bus,
    $store: store,
  };
  if (options.ipc) {
    windowObject['ipcRenderer'] = options.ipc;
    windowObject['require'] = () => ({ ipcRenderer: options.ipc });
  }

  const context: Record<string, unknown> = {
    window: windowObject,
    document,
    navigator: {
      clipboard: {
        write: options.clipboardWrite ?? (() => Promise.resolve()),
      },
    },
    setTimeout,
    clearTimeout,
    Blob,
    ClipboardItem: FakeClipboardItem,
    MouseEvent: FakeMouseEvent,
    Math: options.math ?? Math,
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    console,
  };

  return { context, editor, events, commits };
}

export async function runRendererScript<T>(
  script: string,
  context: Record<string, unknown>
): Promise<T> {
  const result = runInNewContext(script, context) as T | Promise<T>;
  return await result;
}
