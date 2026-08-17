import { File, FileText, FileSpreadsheet, Image as ImageIcon, Mail } from 'lucide-react';

/** Mirrors the backend whitelist in suppliers.py (_PO_ATTACHMENT_EXT). */
export const PO_ATTACHMENT_ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.doc,.docx,.xls,.xlsx,.csv,.txt,.ppt,.pptx,.eml,.msg';

export function formatBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const EXT_ICON: Record<string, typeof File> = {
  pdf: FileText, doc: FileText, docx: FileText, txt: FileText,
  xls: FileSpreadsheet, xlsx: FileSpreadsheet, csv: FileSpreadsheet,
  png: ImageIcon, jpg: ImageIcon, jpeg: ImageIcon, gif: ImageIcon, webp: ImageIcon, heic: ImageIcon,
  eml: Mail, msg: Mail,
};

export function FileTypeIcon({ name, size = 15, className = 'text-gray-500' }: { name: string; size?: number; className?: string }) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const Icon = EXT_ICON[ext] ?? File;
  return <Icon size={size} className={className} />;
}
