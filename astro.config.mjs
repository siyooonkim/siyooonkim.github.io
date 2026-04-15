import mdx from '@astrojs/mdx';
import { defineConfig } from 'astro/config';

export default defineConfig({
	site: 'https://siyooonkim.github.io',
	integrations: [mdx()],
	markdown: {
		shikiConfig: {
			theme: 'github-dark',
			wrap: true,
		},
	},
});
