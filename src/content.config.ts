import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
	type: 'content',
		schema: () =>
			z.object({
				title: z.string(),
				description: z.string(),
				pubDate: z.coerce.date(),
				updatedDate: z.coerce.date().optional(),
				category: z.string(),
				tags: z.array(z.string()).default([]),
				draft: z.boolean().default(false),
				heroImage: z.string().optional(),
			}),
});

export const collections = { blog };
