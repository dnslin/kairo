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
