import { createTokenizer } from '@orama/tokenizers/mandarin';
import { createFromSource } from 'fumadocs-core/search/server';

import { docsSource } from '@/core/docs/source';

// 文档站搜索后端。(docs)/layout.tsx 的 RootProvider 把搜索接口指到这里；
// 缺了这个 route，搜索框每次查询都 404，对所有用户静默坏死。
//
// 文档是双语的，索引按 locale 分开：orama 内置分词器不支持中文
// （SUPPORTED_LANGUAGES 无 mandarin），中文页必须挂 mandarin 分词器，
// 否则整句被当成一个 token，等于搜不到。
export const { GET } = createFromSource(docsSource, {
  localeMap: {
    en: { language: 'english' },
    zh: {
      components: { tokenizer: createTokenizer() },
      search: { threshold: 0, tolerance: 0 },
    },
  },
});
