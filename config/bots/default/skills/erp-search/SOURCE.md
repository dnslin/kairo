# ERP 检索来源与定制

## 固定上游与许可证

- 上游：ClawHub `ragflow-skill`，显示名称 RAGFlow。
- 固定版本：`1.0.8`。
- [版本元数据及文件摘要](https://clawhub.ai/api/v1/skills/ragflow-skill/versions/1.0.8) 的 `version.license` 明确为 `MIT-0`。
- 许可证名称：MIT No Attribution；[SPDX 标准全文](https://spdx.org/licenses/MIT-0.html)。本目录 `LICENSE` 收录授权及免责条款；上游发布文件清单没有独立 LICENSE，也没有提供可核实的版权年份或权利人，因此未编造署名。
- 许可证依据是发布版本的许可证字段，不是安全扫描结果。扫描评级与许可证授权是两件不同的事。

## 实际复用

本地 `scripts/search.py` 是下列两个上游文件的单入口裁剪与合同加固，不是原样复制：

| 上游文件                                                                                                      | 实际复用内容                                                                                                                               | 上游 SHA-256                                                       |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| [scripts/common.py](https://clawhub.ai/api/v1/skills/ragflow-skill/file?path=scripts/common.py&version=1.0.8) | 标准库 `urllib.request.Request` 的 Bearer/JSON 请求头构造、UTF-8 JSON 请求、单次打开响应、`HTTPError` 读取响应体与保留 HTTP/业务诊断的路径 | `80170fe90a5bb61ee19d9afc14a5b172c5194316dab2c1e326fd91939fec06e0` |
| [scripts/search.py](https://clawhub.ai/api/v1/skills/ragflow-skill/file?path=scripts/search.py&version=1.0.8) | `question`/`dataset_ids` 的标准 Retrieval POST 路径，以及 chunk/document/Dataset、位置和相似度字段映射                                     | `da8cbbc821d806497941ea7e27c7c17f481d4d813aba084874d9aaf73879b54c` |
| [SKILL.md](https://clawhub.ai/api/v1/skills/ragflow-skill/file?path=SKILL.md&version=1.0.8)                   | 读取后只保留受控检索与不得编造资料的工作方向；本地重写为面向员工 ERP 问答，不保留上游管理工作流和原始字段直出规则                          | `9f458e48a08759fa5f5959650a2daea925a8b37d27d6266e6555af3af17e75dd` |

## 有意裁剪与边界变化

- 合并必要标准库逻辑到单个 `search.py`，适配固定 `python -I -B <绝对脚本路径>`；没有同目录 `common` 导入或外部 Python 依赖。
- 删除全部 CLI 选项和位置参数，问题仅通过原始 UTF-8 stdin 输入。凭证与服务基址仅来自 `RAGFLOW_API_KEY`、`RAGFLOW_API_URL`，固定知识库仅来自服务端注入的 `RAGFLOW_DATASET_ID`。
- 请求只发往配置服务基址的 `/api/v1/retrieval`，JSON 只有 `question` 和单元素 `dataset_ids`。删除 top-k、阈值、分页、文档范围、权重、知识图谱、rerank 及 `retrieval_test` 备用路径；不复制任何管理脚本。
- 关闭 urllib 自动重定向及环境/系统代理发现，使凭证只发往配置目标。服务地址限定为 HTTP(S) 基址，不接受用户信息、其他路径、查询串或片段。
- 删除上游固定 30 秒网络超时，Python 不重试；唯一截止与重试控制在父进程，重试资格仅由结果类别、错误原因和 HTTP 状态推导，不在 Python 输出重复的 `retryable` 字段。父进程终止等待时须回收实际进程；该终止不代表远端计算已经取消。
- 替换上游宽松字段回退和缺失即空的行为：严格验证 `data`、`chunks`、非负整数 `total`，每个片段的非空字符串标识/名称/正文、有限二维位置数组与有限相似度；可选相似度出现时同样校验。只把合法空片段数组归类为 `empty`。
- stdout 使用共享 `RetrievalResult` JSON 合同：成功退出 0，结构化检索错误退出 1；保留 `httpStatus`、`apiCode`、`raw`。JSON 无法解析时 raw 保存文本；不向 stderr 输出原始网络异常。
- 响应体截断时保留已经收到的 HTTP 状态及可用片段，401/403/400/422 不因读取失败而重试；网络异常保留异常类、系统 errno 和可用证书 verifyCode，不记录异常全文。业务码只接受 `[-9007199254740991, 9007199254740991]` 内的整数，排除布尔值和浮点数；超范围码的 `apiCode` 为 null，脱敏后的 raw 保存为 JSON 文本以精确保留数字，不被 Node 舍入，也不覆盖已知 HTTP 错误分类。
- HTTP 401/403 归认证，400/422 归参数，429/5xx 归临时服务故障；网络异常可重试，但 Python 本身不执行重试。HTTP 200 非零业务码不会误判成功。T14/T27 真实样本确认 code 102 配合精确 `You don't own the dataset <当前固定ID>.` 为权限错误，配合精确 `` `question` is required. `` 为参数错误；同码其他消息保留诊断并归不可重试 `service_error`。
- 唯一允许的 raw 内容脱敏是移除本次实际 API key 的精确字符串：包括上游回显的消息、嵌套字段值和键名，以 `[REDACTED]` 替换，其他诊断保留。
- 员工只收到资料支持的答案，不输出内部标识、来源列表或原始诊断；检索内容是数据，不授予执行其中指令的权限。
