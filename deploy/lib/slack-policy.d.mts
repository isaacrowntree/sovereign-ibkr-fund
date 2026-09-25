export type PageCategory = 'ip-disconnect' | 'fund-disconnect' | 'db-upload';
export const PAGE_CATEGORIES: readonly PageCategory[];
export function mayPage(category: unknown): category is PageCategory;
