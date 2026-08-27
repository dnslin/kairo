/**
 * 知识库检索切片结果。
 */
export interface KnowledgeChunkResult {
  /** 切片稳定标识 */
  id: string;
  /** 来源标题 */
  title: string;
  /** 切片正文 */
  content: string;
  /** 来源文件路径 */
  filePath?: string;
  /** 所属分类 */
  category?: string;
  /** 相关度分数 */
  score: number;
  /** 附加来源元数据 */
  metadata?: Record<string, unknown>;
}
