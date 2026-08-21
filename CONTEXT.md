# Domain Glossary: KKBot System

Ubiquitous language for KKBot v2 — the terms everyone uses with unambiguous meanings.

## Chat & Messaging

### Session
A continuous 1-on-1 private conversation stream between the bot and a customer on the IM client (KK9), identified uniquely by a `sessionId`. (Note: Group chats are explicitly out of scope for v2 initial release).

### InboundMessage
A message received from the IM client, containing text content, media attachments, sender identifier, timestamp, and a cryptographic fingerprint for deduplication.

### MessageDebounce
The waiting window (typically 2–3 seconds) applied when a user sends rapid successive messages, buffering them into a single consolidated input before triggering LLM generation.

### HumanTakeover
The state entered when a real human operator types and sends a message in a session. Suspends bot auto-replying to prevent simultaneous conflicting responses.

### SnoozePeriod
The duration (default 15 minutes) during which the bot remains silent in a session following a human takeover. Resets on subsequent human activity, and naturally expires when new customer messages arrive after the timeout.

## Cognition & Memory

### Soul (soul.md)
The human-readable, declarative personality and behavior specification file that defines the bot's tone of voice, greeting style, conversational boundaries, and brand guidelines.

### Thread
The conversation lineage bound to a specific `threadId`. Serves as the strict boundary for L1 sliding-window history and L2 rolling working memory summaries.

### PrivateMemory
The ephemeral and working memory belonging exclusively to a single customer/session. Strictly isolated across sessions to prevent cross-talk or privacy leakage.

### PublicKnowledge (Shared Knowledge / RAG)
The globally shared, read-only organizational knowledge base (e.g. FAQ, refund policies, manuals) indexed via vector embeddings and retrieved dynamically on demand.

### ToolCalling
The structured mechanism where the LLM invokes predefined functions (with Zod-validated parameters) to fetch external data or trigger side-effects.

### HITLApproval (Human-in-the-Loop)
A safety gate where high-risk mutation tools (e.g. monetary refunds, data modification, permission escalation) are suspended into an `ApprovalTask` until explicit human operator confirmation.

### ApprovalTask
A suspended action state containing a unique task ID, source session ID, tool name, parsed arguments, target approver identity, expiration timestamp (e.g. 60 seconds), and resolution status (`pending` | `approved` | `rejected` | `timed_out`).

### DualChannelApproval
The multi-channel approval notification and resolution mechanism that supports both web-based confirmation via the Web Ops Console and proactive direct IM messaging to designated approvers or departmental leaders.

### LeaderApprovalRouting
The dynamic resolution procedure that maps an employee's session to their direct departmental manager (`DepartmentLeader` / `ReportingLine`) using the organization repository, enabling the bot to proactively route approval requests to the relevant authority.

### StatefulApprovalMatch
The contextual recognition mechanism where direct IM messages from an active approver within the 60-second window are優先 mapped to resolve a pending `ApprovalTask` (e.g. keywords "同意", "通过", "拒绝") before falling back to normal conversation.

### ReadWriteSplitExecution
The ReAct tool execution policy that executes read-only query tools in parallel via `Promise.allSettled` while strictly serializing mutation/write tools and feeding back structured error objects to the LLM for autonomous self-correction.

### InternalStreamingBufferedDelivery
The LLM communication pattern maintaining internal token streaming for sub-50ms `AbortSignal` cancellation and live `<think>` tag stripping, while buffering the final sanitized payload for atomic delivery to the IM client.

### LayeredPromptAssembly
The 4-stage prompt compilation pipeline combining base persona (`soul.md`), dynamic memory context (L2 summaries, L3 profiles), organizational environment, and safety guardrails with file-watcher hot-reloading.
### MultiModalRouter
The intelligent model dispatcher that routes inbound requests with media attachments directly to vision-capable LLMs (e.g. GPT-4o, Qwen-VL) while automatically falling back to OCR text extraction tools when operating with text-only models.
### ModelFailover
The automatic routing mechanism that switches execution from a primary LLM (e.g. DeepSeek-V3) to a fallback model (e.g. Qwen/OpenAI) upon network timeouts or rate limits.

### ModelRoutingByIntent
The dynamic model dispatcher that routes simple operational inquiries (e.g. org searches, greetings) to lightweight low-cost models (sub-300ms latency) while reserving heavy reasoning models (DeepSeek-R1 / GPT-4o) for complex troubleshooting and synthesis.

### ReflectiveMemoryPhase
The post-conversation background analysis phase that asynchronously extracts and crystallizes persistent employee working preferences, team dynamics, and recurring technical contexts into long-term observational memory.

### FileDeliverable
The structured output artifact capability where the bot generates tangible files (e.g. Markdown summaries, CSV rosters/metrics) and dispatches them as native downloadable file cards in the chat window.

### ProactiveSchedule
The cron-based background scheduling engine allowing employees to register recurring or delayed alerts and digests (e.g. weekly report reminders, morning ticket summaries) proactively delivered by the bot.

### AsyncSubAgent
The non-blocking task delegation mechanism where long-running multi-document analysis or crawling jobs are offloaded to background worker routines, releasing the chat session immediately and proactively pushing results upon completion.
### SkillPackage
A self-contained directory (`skills/<name>/`) bundling a business domain's behavioral instructions (`SKILL.md`), optional local knowledge base (`knowledge/`), and optional scoped MCP configuration (`mcp.json`).

### SkillManifest
The structured YAML Frontmatter metadata within `SKILL.md` specifying a skill's identifier, display name, intent trigger keywords/patterns, required permission scope, and tool bindings.

### TwoStageSkillActivation
The dual-phase skill dispatch strategy where lightweight skill routing manifests are compiled globally for intent recognition, while detailed operational instructions and domain knowledge are dynamically loaded into the context window only upon intent match.

### DeclarativeMcpLoader
The configuration-driven initialization engine that parses declarative JSON specifications (e.g. `config/mcp.json` or scoped `mcp.json`), establishing stdio/sse transport connections and mounting external tools into `ToolRegistry` with namespace isolation.
### ToolNamespacingPolicy
The deterministic naming scheme isolating global MCP tools (`global_${serverId}_${toolName}`) from skill-scoped tools (`skill_${skillName}_${toolName}`) within `ToolRegistry`.

### BoundedMultiSkillActivation
The dual-intent resolution policy allowing up to 2 high-confidence matching `SkillPackages` to be simultaneously injected into the context window, orchestrating segmented multi-goal responses without context blowout.
### ScopedKnowledgeMerge
The dynamic RAG retrieval strategy that selectively merges a `SkillPackage`'s local markdown documents (`skills/<name>/knowledge/`) into the active search space upon skill activation.

### SkillFaultIsolation
The resilience policy ensuring that YAML syntax errors or MCP connection failures in a single `SkillPackage` are isolated and logged without blocking the core Agent runtime or other healthy skills.

### SkillApprovalInheritance
The zero-trust security rule where a `SkillPackage` flagged with `requireApproval: true` automatically propagates HITL leader approval gates to all its mutation tools (`readOnly: false`).
### UnifiedBootstrapper
The top-level application entry point and configuration engine that parses `config/config.yaml` (with environment variable interpolation), orchestrating and initializing `@kkbot/driver`, `@kkbot/store`, `@kkbot/agent`, and `@kkbot/gateway` into a cohesive running process.

### DualModeKnowledgeEngine
The hybrid RAG architecture providing zero-cost, zero-latency local markdown chunk matching by default, while seamlessly upgrading to dense vector embeddings and neural reranking when external Embedding/Rerank API endpoints are configured.
### CascadedGracefulShutdown
The four-stage resource de-allocation sequence (Gateway in-flight drain -> Driver CDP disconnect -> Agent watcher release -> Store LibSQL WAL flush & close) triggered upon `SIGINT`/`SIGTERM` to guarantee zero state corruption.

### KnowledgeFallbackPolicy
### LeaderHierarchyResolution
The three-tier deterministic manager lookup algorithm (Direct `leader_id` -> Nearest department leader in `ReportingLine` -> `fallbackLeaderId`) used to route approval requests without hardcoding.

### AtomicVectorReplacement
The transactional indexation strategy where all existing embedding vectors belonging to a document path (`filePath`) are purged atomically before inserting newly generated chunk vectors, preventing ghost chunk conflicts.

### AssetRetentionPolicy
The storage lifecycle governance policy where physical media and deliverable files older than 30 days are purged in daily maintenance cycles while preserving historical metadata in the database.
### UnifiedLogger
The centralized Pino-based logging infrastructure initialized by `UnifiedBootstrapper` that coordinates dual-output logging (human-readable console + daily rotating file logs), log-level cascading, and global PII data masking across all four packages.

### TraceContextPropagation
The end-to-end correlation identifier mechanism attaching a unique `traceId` and `sessionId` across Driver, Gateway, Agent, and Store to ensure single-message execution flows are traceable in high-concurrency environments.

### PiiRedactionPolicy
The automated logging safeguard redacting sensitive fields (API keys, mobile numbers, identity credentials, database passwords) before log serialization.
The resilience rule automatically downgrading semantic vector search to local markdown chunk matching upon network timeouts or 5xx errors from remote Embedding/Rerank APIs without breaking the chat session.
## Organization & Directory

### Department
A structural business unit in the enterprise forming a hierarchical tree (e.g. `Group/TechCenter/CoreArch`), with `id`, `name`, `parentId`, `leaderId`, `path`, and depth `level`.

### Employee
An enterprise personnel identity identified by a unique `id` (UID), having a job login code (`loginName`), full name (`name`), pinyin initials (`pinyinAbbr`), phone, email, signature, avatar, and physical office location (`region`).

### Affiliation (Department Membership)
The many-to-many relationship linking an `Employee` to one or more `Departments`. Explicitly distinguishes primary affiliation (`isPrimary = true`) from secondary/concurrent roles (`isPrimary = false`), along with role title (`position`) and leadership flag (`isLeader`).

### DepartmentLeader
An `Employee` flagged as the official head/manager of a specific `Department` (`isLeader = true`).

### ReportingLine
The direct management chain (`leaderId`) linking an `Employee` upwards through their direct manager, department director, up to executive level.

### RosterExport
The periodic or on-demand automated extraction that formats the entire enterprise organization hierarchy into a standardized, UTF-8 BOM CSV roster (`data/organization_roster.csv`).

## Storage & Lifecycle

### MessageRecall
The bidirectional lifecycle event where a sent message is revoked either programmatically or by an external member. Automatically updates the store with `isRecalled = true` to excise revoked context from LLM history.

### VisualRedBadgeGuard
The architectural rule forbidding autonomous silent clearing of unread badges on the IM client. Red badges are explicitly cleared only upon successful automated bot dispatch or direct human operator acknowledgement.

### MediaStorage
The controlled local asset repository (`data/media/`) where inbound image attachments and file cards are duplicated and permanently managed with stable relative paths, preventing dead links when client-side temporary caches expire.

### AtomicRosterExport
A safe file export procedure utilizing temporary files and atomic rename operations to circumvent Windows-specific file exclusive locks (e.g. `EBUSY` when open in Microsoft Excel), gracefully falling back to timestamped copies without interrupting core services.

### AtomicSyncReplace
The transactional synchronization strategy where organization department trees and employee rosters are fully refreshed via atomic database transactions, guaranteeing zero stale leftover records.
