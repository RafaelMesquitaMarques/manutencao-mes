import api from './axios';

export interface UploadResult {
  url: string;
  filename: string;
  media_type: 'image' | 'video';
  content_type: string;
  size: number;
}

/** Upload a photo/video to the server. Returns a served URL under /api/media/. */
export const uploadFile = async (
  file: File,
  onProgress?: (pct: number) => void
): Promise<UploadResult> => {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post<UploadResult>('/api/uploads', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    onUploadProgress: (e) => {
      if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
    },
  });
  return data;
};
