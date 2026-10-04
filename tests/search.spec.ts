import { test, expect } from '@playwright/test';
import { appendTagSearch, formatTagSearch, parseSearch } from '../src/lib/search';

test('hashtag syntax preserves plain text and round-trips real tag names', () => {
  const parsed = parseSearch('sunset #Forest #"green trees" #forest lake');
  expect(parsed.tags).toEqual(['forest', 'green trees']);
  expect(parsed.text.replace(/\s+/g, ' ')).toBe('sunset lake');
  expect(parseSearch('mail@example.com photo#1').tags).toEqual([]);
  for (const name of [
    'forest',
    'green trees',
    'say "hello"',
    'path\\name',
    'c#',
    '日本語',
    "x'; DROP TABLE tags; --",
  ]) {
    expect(parseSearch(formatTagSearch(name)).tags).toEqual([name.toLowerCase()]);
  }
  expect(parseSearch('#"green tr').tokens[0].name).toBe('green tr');
  expect(parseSearch('#').tags).toEqual([]);
  expect(appendTagSearch('sunset #forest', 'forest')).toBe('sunset #forest');
  expect(appendTagSearch('sunset #forest', 'green trees')).toBe('sunset #forest #"green trees"');
});
