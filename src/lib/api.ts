import { invoke } from '@tauri-apps/api/core';
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
  tags: string[];
  category: string | null;
  status: 'pending' | 'classified' | 'error';
  error: string | null;
  modified: number;
}
export interface Filter {
  query: string;
  folderId: number | null;
  tag: string | null;
  status: string | null;
  page: number;
}
export interface Page {
  images: Photo[];
  total: number;
}
export interface Tag {
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
  search: (filter: Filter) => invoke<Page>('search', { filter }),
  tags: (folderId: number | null) => invoke<Tag[]>('tags', { folderId }),
  stats: () => invoke<Stats>('stats'),
  status: () => invoke<Status>('status'),
  start: (action: 'scan' | 'classify' | 'download') => invoke<void>('start', { action }),
  pause: () => invoke<void>('pause'),
  automatic: (enabled: boolean) => invoke<void>('automatic', { enabled }),
  retry: (folderId: number | null) => invoke<void>('retry', { folderId }),
  savePhoto: (id: number, classification: Classification) =>
    invoke<void>('save_photo', { id, classification }),
  thumbnail: (id: number) => invoke<string>('thumbnail', { id }),
  preview: (id: number) => invoke<string>('preview', { id }),
};
