import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({
  dir: 'content/docs',
});

export const pages = defineDocs({
  dir: 'content/pages',
});

export const posts = defineDocs({
  dir: 'content/posts',
});

export const logs = defineDocs({
  dir: 'content/logs',
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      // docs/05 §5：代码块在浅色模式下也用深底，制造“终端”对比。
      // 两个模式统一深色主题，背景由 mdx-components 的 keepBackground 保留。
      themes: {
        light: 'github-dark-default',
        dark: 'github-dark-default',
      },
      // Use defaultLanguage for unknown language codes
      defaultLanguage: 'plaintext',
    },
  },
});
