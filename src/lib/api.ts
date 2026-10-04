import { invoke } from '@tauri-apps/api/core';
import { parseSearch } from './search';
export interface Folder {
  id: number;
  path: string;
  name: string;
  enabled: boolean;
  categories: string[];
  instructions: string;
  count: number;
  pending: number;
}
export interface Photo {
  id: number;
  folderId: number;
  path: string;
  filename: string;
  caption: string;
  tags: PhotoTag[];
  category: string | null;
  status: 'pending' | 'classified' | 'error';
  error: string | null;
  modified: number;
}
export interface Filter {
  query: string;
  folderId: number | null;
  tags?: string[];
  status: string | null;
  page: number;
}
export interface Page {
  images: Photo[];
  total: number;
}
export type TagSource = 'ai' | 'user' | 'folder';
export interface PhotoTag {
  id: number;
  name: string;
  sources: TagSource[];
}
export interface TagPage {
  tags: Tag[];
  total: number;
  orphans: number;
}
export interface Tag {
  id: number;
  name: string;
  count: number;
}
export interface Stats {
  total: number;
  classified: number;
  pending: number;
  errors: number;
}
export interface Status {
  busy: boolean;
  phase: string;
  message: string;
  processed: number;
  modelReady: boolean;
  automatic: boolean;
  revision: number;
}
export interface Classification {
  tags: string[];
  caption: string;
  category: string | null;
}
export type ImageAction = 'copy_image' | 'copy_path' | 'reveal' | 'open';
export const api = {
  imageAction: (id: number, action: ImageAction) => invoke<void>('image_action', { id, action }),
  folders: () => invoke<Folder[]>('folders'),
  addFolder: (path: string) => invoke<void>('add_folder', { path }),
  saveFolder: (folder: Folder) => invoke<void>('save_folder', { folder }),
  removeFolder: (id: number) => invoke<void>('remove_folder', { id }),
  search: (filter: Filter) => {
    const parsed = parseSearch(filter.query);
    return invoke<Page>('search', { filter: { ...filter, query: parsed.text, tags: parsed.tags } });
  },
  tags: (folderId: number | null) => invoke<Tag[]>('tags', { folderId }),
  tagCatalog: (query: string, orphansOnly: boolean, page: number) =>
    invoke<TagPage>('tag_catalog', { query, orphansOnly, page }),
  tagSuggestions: (query: string, prefix = false) =>
    invoke<Tag[]>('tag_suggestions', { query, prefix }),
  renameTag: (id: number, name: string) => invoke<void>('rename_tag', { id, name }),
  deleteTag: (id: number) => invoke<void>('delete_tag', { id }),
  purgeOrphanTags: () => invoke<number>('purge_orphan_tags'),
  stats: () => invoke<Stats>('stats'),
  status: () => invoke<Status>('status'),
  start: (action: 'scan' | 'classify' | 'download') => invoke<void>('start', { action }),
  pause: () => invoke<void>('pause'),
  automatic: (enabled: boolean) => invoke<void>('automatic', { enabled }),
  retry: (folderId: number | null) => invoke<void>('retry', { folderId }),
  savePhoto: (id: number, classification: Classification) =>
    invoke<void>('save_photo', { id, classification }),
  trashPhoto: (id: number) => invoke<void>('trash_photo', { id }),
  thumbnail: (id: number) => invoke<string>('thumbnail', { id }),
  preview: (id: number) => invoke<string>('preview', { id }),
};
