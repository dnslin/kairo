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
A safety gate where high-risk mutation tools (e.g. monetary refunds, data modification) are suspended until explicit human operator confirmation via the management console.

### ModelFailover
The automatic routing mechanism that switches execution from a primary LLM (e.g. DeepSeek-V3) to a fallback model (e.g. Qwen/OpenAI) upon network timeouts or rate limits.

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
