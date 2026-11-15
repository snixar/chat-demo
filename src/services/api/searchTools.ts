/**
 * 客户端联网工具的声明文本。
 *
 * 工具名与 rikkahub 保持一致：`search_web` / `scrape_web`。
 * 实际执行时打哪个搜索服务由 services/search/store 决定（用户选中的实例，
 * 缺省回退到 DeepSeek + 官方 Key），因此这里不再绑定具体服务商。
 */

export const SEARCH_TOOL_NAME = 'search_web'
export const FETCH_TOOL_NAME = 'scrape_web'

/** 一次搜索返回的条数 */
export const SEARCH_RESULT_SIZE = 10

/** 给模型的查询建议；各家的搜索质量对这个提示很敏感 */
export const SEARCH_QUERY_DESCRIPTION =
  'Concise search keywords, not a full sentence. Write them in the language the best sources on the topic are written in: usually English for technology, science and international topics; the local language for region-specific topics. Keep proper nouns, product names and error messages verbatim.'

/** search_web 的工具描述，含引用格式约定 */
export const SEARCH_TOOL_DESCRIPTION = `Search the web for up-to-date or specific information.
Use this when the user asks for the latest news, current facts, or needs verification.
Do not treat result order as proof of freshness. Prefer primary sources and inspect each result's title, URL, publication date, and content before making a current claim.
If a date or primary source is missing, or sources conflict, run another focused search or use ${FETCH_TOOL_NAME} to verify the most relevant source before answering.
Generate focused keywords and run multiple searches if needed.

Response format:
- Each item has a short id, index, title, url, optional publishedDate and domain.
- highlights contains quoted relevant passages when the provider returns them.

Citations:
- After using results, add a citation right after the sentence it supports, using the result's URL as the link target: \`[citation,domain](url)\`.
- Use exactly the \`url\` and \`domain\` fields from the result item, verbatim.
- Multiple citations are allowed.
- If no results are cited, omit citations.

Images:
- When images help the user understand the answer, embed relevant ones using Markdown: \`![](url)\`.
- Only use urls from the images list (never fabricate or alter urls).

Example:
The capital of France is Paris. [citation,example.com](https://example.com/paris)`

/** scrape_web 的工具描述 */
export const FETCH_TOOL_DESCRIPTION = `Scrape a URL for detailed page content.
Use this when the user requests content from a specific page, when search snippets are insufficient, or when a current claim needs verification against a specific source.
Avoid using it for common questions unless the user asks.`
