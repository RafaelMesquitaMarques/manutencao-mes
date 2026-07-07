import api from './axios';

export interface EscalationSettings {
  sla_critical_minutes: number;
  sla_high_minutes: number;
  sla_medium_minutes: number;
  sla_low_minutes: number;
  max_escalation_level: number;
  sms_enabled: boolean;
  email_enabled: boolean;
  notify_on_critical_alert: boolean;
  notify_on_ticket_assigned: boolean;
  notify_on_pm_overdue: boolean;
  notify_on_ticket_opened: boolean;
  notify_on_ticket_completed: boolean;
  technician_self_assign: boolean;
  shift_report_enabled: boolean;
  ticket_group_min_priority: 'low' | 'medium' | 'high' | 'critical';
  reminder_minutes: number;
  pause_during_planned_stop: boolean;
  sms_templates: Record<string, string>;
  channel_matrix: Record<string, { sms?: boolean; email?: boolean }>;
  sms_template_defaults: Record<string, string>;
  twilio_configured: boolean;
}

export interface EscalationContact {
  id: string;
  level: number;
  user_id: string;
  user_name: string;
  user_phone: string | null;
  user_email: string | null;
  via_sms: boolean;
  via_email: boolean;
  is_active: boolean;
  scope_department: string | null;
  scope_machine_ids: string[];
  notify_start: string | null;
  notify_end: string | null;
  critical_bypass: boolean;
}

export interface NotificationLogEntry {
  id: string;
  type: string;
  recipient_role: string | null;
  recipient_name: string | null;
  recipient_contact: string | null;
  message: string;
  status: string;
  created_at: string | null;
}

export async function fetchEscalationSettings(): Promise<{ settings: EscalationSettings; contacts: EscalationContact[] }> {
  const { data } = await api.get('/api/escalation/settings');
  return data;
}

export async function updateEscalationSettings(body: Partial<EscalationSettings>): Promise<EscalationSettings> {
  const { data } = await api.patch('/api/escalation/settings', body);
  return data;
}

export async function addEscalationContact(body: {
  level: number;
  user_id: string;
  via_sms?: boolean;
  via_email?: boolean;
}): Promise<EscalationContact> {
  const { data } = await api.post('/api/escalation/contacts', body);
  return data;
}

export async function updateEscalationContact(
  id: string,
  body: Partial<Pick<EscalationContact,
    'via_sms' | 'via_email' | 'is_active' | 'level' |
    'scope_department' | 'scope_machine_ids' | 'notify_start' | 'notify_end' | 'critical_bypass'
  >>,
): Promise<EscalationContact> {
  const { data } = await api.patch(`/api/escalation/contacts/${id}`, body);
  return data;
}

export async function deleteEscalationContact(id: string): Promise<void> {
  await api.delete(`/api/escalation/contacts/${id}`);
}

export interface NotificationLogFilters {
  limit?: number;
  offset?: number;
  type?: string;
  status?: string;
  q?: string;
}

export async function fetchNotificationLog(
  filters: NotificationLogFilters = {},
): Promise<{ total: number; items: NotificationLogEntry[] }> {
  const { data } = await api.get('/api/escalation/notifications', {
    params: { limit: 50, ...filters },
  });
  return data;
}

export async function resendNotification(id: string): Promise<{ status: string }> {
  const { data } = await api.post(`/api/escalation/notifications/${id}/resend`);
  return data;
}

export async function sendTestSms(phone?: string): Promise<{ status: string; twilio_configured: boolean; phone: string }> {
  const { data } = await api.post('/api/escalation/test-sms', { phone: phone || undefined });
  return data;
}

export interface ShiftReportPreview {
  shift_key: string;
  window_start: string;
  window_end: string;
  machines_included: number;
  text: string;
}

export async function fetchShiftReportPreview(): Promise<ShiftReportPreview> {
  const { data } = await api.get('/api/escalation/shift-report/preview');
  return data;
}

export async function sendTestShiftReport(): Promise<{ status: string; twilio_configured: boolean; text: string }> {
  const { data } = await api.post('/api/escalation/shift-report/test');
  return data;
}
