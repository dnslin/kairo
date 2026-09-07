import { createStudioMastra } from '../dev-server.js';

// 仅供 dev:studio 加载；正式入口不导入此模块。
export const mastra = createStudioMastra();
