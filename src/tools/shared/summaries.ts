import type { Json } from '../../ghost.js';
import { names } from './helpers.js';

export function summarizeContent(r: Json, opts: { html?: boolean; lexical?: boolean } = {}): Json {
  const out: Json = {
    id: r.id,
    title: r.title,
    slug: r.slug,
    status: r.status,
    visibility: r.visibility,
    featured: r.featured,
    url: r.url,
    created_at: r.created_at,
    updated_at: r.updated_at,
    published_at: r.published_at,
    excerpt: r.custom_excerpt ?? r.excerpt,
    feature_image: r.feature_image,
    tags: names(r.tags),
    authors: names(r.authors),
    reading_time: r.reading_time,
  };
  if (opts.html) out.html = r.html;
  if (opts.lexical) out.lexical = r.lexical;
  return out;
}

export const summarizeTag = (t: Json): Json => ({
  id: t.id,
  name: t.name,
  slug: t.slug,
  description: t.description,
  visibility: t.visibility,
  feature_image: t.feature_image,
  url: t.url,
  posts: t.count?.posts,
});

export const summarizeMember = (m: Json): Json => ({
  id: m.id,
  email: m.email,
  name: m.name,
  note: m.note,
  status: m.status,
  subscribed: m.subscribed,
  created_at: m.created_at,
  labels: names(m.labels),
  newsletters: names(m.newsletters),
  tiers: names(m.tiers),
});
