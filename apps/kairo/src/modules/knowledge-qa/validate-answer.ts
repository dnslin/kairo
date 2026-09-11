import { answerSchema, type AgentAnswer } from './answer-schema.js';
import type { KnowledgeEvidence, KnowledgeQuery } from './knowledge-record-store.js';

export type AnswerValidation =
  | { status: 'accepted'; answer: AgentAnswer; diagnostics: string[] }
  | { status: 'rejected'; errorType: 'model' | 'knowledge'; diagnostics: string[] };

// 仅提示资料中明确的越权指令，不声称穷尽注入，也不据此自动否定有效依据。
const suspectedInjection =
  /(?:忽略|无视|绕过)[^。！？\n]{0,32}(?:规则|指令|提示词|系统)|(?:调用|使用|执行)[^。！？\n]{0,24}(?:其他|其它|另外|未授权)[^。！？\n]{0,16}(?:tool|工具)|(?:ignore|disregard|override)\b[^.!?\n]{0,64}\b(?:instructions?|rules?|system\s+prompt)\b|(?:call|invoke|execute|use)\b[^.!?\n]{0,32}\b(?:another|other|unauthorized)\s+tools?\b/i;

// 原始检索协议没有标准来源 URL 字段；只检查明确来源呈现，不把业务链接当来源。
const sourceHeading =
  /(?:^|\n)\s*(?:#{1,6}\s*|[-*]\s+)?(?:\*\*|__)?(?:来源(?:列表|清单|链接)?|资料来源|参考(?:资料|文献|来源)|引用(?:资料|来源|列表)|sources?|references|citations)(?:\*\*|__)?\s*(?:[:：]|\r?$)/im;
const sourceField =
  /["'](?:sources?|references|citations|evidenceIds|documentId|chunkId|pageNumbers|similarity|rawResult|来源(?:列表|清单)?|资料来源|参考资料)["']\s*:/i;
const sourceMarkdownLink =
  /\[(?:来源|资料来源|原文|参考(?:资料|文献|来源)|引用(?:资料|来源)|sources?|references?|citations?)[^\]\n]*\]\(\s*(?:https?:\/\/|\/)/i;
const sourceInlineLink =
  /(?:^|[\s。；;（(])(?:\*\*|__)?(?:来源(?:链接)?|资料来源|原文(?:链接)?|参考(?:资料|文献|来源)|sources?|references?|citations?)(?:\*\*|__)?\s*[:：]\s*<?https?:\/\//i;

/** 只检查结构、当前账本证据链与正文泄漏；当前任务状态和自然语言正确性不由此函数证明。 */
export function validateAnswer(
  output: unknown,
  scope: { taskId: string; attemptId: string; datasetId: string },
  facts: { queries: KnowledgeQuery[]; evidence: KnowledgeEvidence[] }
): AnswerValidation {
  const currentQueries = new Map(
    facts.queries
      .filter(query => query.taskId === scope.taskId && query.attemptId === scope.attemptId)
      .map(query => [query.queryId, query])
  );
  const currentEvidence = facts.evidence.filter(
    evidence => evidence.taskId === scope.taskId && currentQueries.has(evidence.queryId)
  );
  const diagnostics: string[] = [];
  if (currentEvidence.some(evidence => suspectedInjection.test(evidence.content))) {
    diagnostics.push('本次资料存在疑似提示注入指令，仅作为参考资料处理。');
  }
  function reject(errorType: 'model' | 'knowledge', diagnostic: string): AnswerValidation {
    return { status: 'rejected', errorType, diagnostics: [...diagnostics, diagnostic] };
  }

  const parsed = answerSchema.safeParse(output);
  if (!parsed.success) return reject('model', '模型答案结构不符合完整答案协议。');
  const answer = parsed.data;
  if (
    answer.answerType !== 'enterprise' ||
    !answer.answer.trim() ||
    answer.subQuestions.some(part => part.answerType !== 'enterprise' || !part.answer.trim())
  ) {
    return reject('model', '本次仅接受正文非空的完整企业答案。');
  }
  if (!answer.evidenceIds.length || answer.subQuestions.some(part => !part.evidenceIds.length)) {
    return reject('knowledge', '企业答案及其子问题必须具有明确的资料依据。');
  }
  const declaredIds = new Set(answer.evidenceIds);
  if (answer.subQuestions.some(part => part.evidenceIds.some(id => !declaredIds.has(id)))) {
    return reject('knowledge', '总答案的资料依据未覆盖全部子问题。');
  }
  const evidenceById = new Map(currentEvidence.map(evidence => [evidence.evidenceId, evidence]));
  for (const id of declaredIds) {
    const evidence = evidenceById.get(id);
    const query = evidence && currentQueries.get(evidence.queryId);
    if (
      !evidence ||
      !query ||
      query.datasetId !== scope.datasetId ||
      query.toolId !== 'knowledge-search' ||
      query.resultCategory !== 'found' ||
      !evidence.content.trim() ||
      evidence.conflict !== false
    ) {
      return reject('knowledge', '声明的资料依据缺失、归属不符、为空或存在冲突。');
    }
  }

  // 检查本次全部已知编号，而非只检查模型声称采用的资料；内部结构不拼入正文。
  const internalIds = new Set<string>();
  internalIds.add(scope.taskId);
  internalIds.add(scope.attemptId);
  for (const query of currentQueries.values()) {
    internalIds.add(query.queryId);
    internalIds.add(query.datasetId);
    internalIds.add(query.bootId);
  }
  for (const evidence of currentEvidence) {
    internalIds.add(evidence.evidenceId);
    internalIds.add(evidence.documentId);
    internalIds.add(evidence.chunkId);
  }
  for (const id of internalIds) {
    if (id && answer.answer.includes(id)) {
      return reject('model', '答案正文包含本次资料的内部编号，不能发送原文。');
    }
  }
  if (
    sourceHeading.test(answer.answer) ||
    sourceField.test(answer.answer) ||
    sourceMarkdownLink.test(answer.answer) ||
    sourceInlineLink.test(answer.answer)
  ) {
    return reject('model', '答案正文包含来源清单或明确来源链接，不能发送原文。');
  }

  // 模型 diagnostics 属于不可信输入，不进入服务端诊断；正文保持已检查的精确原文。
  return {
    status: 'accepted',
    answer: { ...answer, evidenceIds: [...declaredIds], diagnostics: [...diagnostics] },
    diagnostics,
  };
}
