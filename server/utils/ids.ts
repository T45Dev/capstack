import { customAlphabet } from 'nanoid'

const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789'
const nano = customAlphabet(ALPHA, 12)

export function newId(prefix?: string): string {
  return prefix ? `${prefix}_${nano()}` : nano()
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}
