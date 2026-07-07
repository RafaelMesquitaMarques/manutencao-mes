import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, CalendarOff, Plus, Loader2, Trash2, X, Check, Pencil } from 'lucide-react';
import {
  fetchCalendarSettings, saveCalendarSettings, addHoliday, updateHoliday, deleteHoliday,
  type FactoryCalendarSettings,
} from '../../api/calendar';
import { usePermission } from '../../hooks/usePermission';
import Spinner from '../../components/ui/Spinner';

export default function FactoryCalendar() {
  const { t, i18n } = useTranslation();
  const lang = (i18n.language || 'en').slice(0, 2);
  const canEdit = usePermission('calendar', 'update');

  const [data, setData] = useState<FactoryCalendarSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingToggle, setSavingToggle] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState(false);
  const [newDate, setNewDate] = useState('');
  const [newName, setNewName] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editName, setEditName] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await fetchCalendarSettings()); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const flashSaved = () => { setSaved(true); setTimeout(() => setSaved(false), 2500); };

  const toggleWeekends = async (value: boolean) => {
    if (!data) return;
    setSavingToggle(true); setErr('');
    try {
      setData(await saveCalendarSettings(value));
      flashSaved();
    } catch { setErr(t('common.error')); }
    finally { setSavingToggle(false); }
  };

  const handleAdd = async () => {
    if (!newDate) return;
    setBusy(true); setErr('');
    try {
      await addHoliday(newDate, newName.trim());
      setNewDate(''); setNewName('');
      setData(await fetchCalendarSettings());
      flashSaved();
    } catch (e: unknown) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(d === 'holiday_exists' ? t('calendar.holidayExists') : t('common.error'));
    } finally { setBusy(false); }
  };

  const handleDelete = async (id: string) => {
    setErr('');
    try {
      await deleteHoliday(id);
      setData(await fetchCalendarSettings());
    } catch { setErr(t('common.error')); }
  };

  const startEdit = (id: string, date: string, name: string) => {
    setErr(''); setEditId(id); setEditDate(date); setEditName(name);
  };
  const cancelEdit = () => { setEditId(null); setEditDate(''); setEditName(''); };

  const handleEditSave = async () => {
    if (!editId || !editDate) return;
    setSavingEdit(true); setErr('');
    try {
      await updateHoliday(editId, editDate, editName.trim());
      cancelEdit();
      setData(await fetchCalendarSettings());
      flashSaved();
    } catch (e: unknown) {
      const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      setErr(d === 'holiday_exists' ? t('calendar.holidayExists') : t('common.error'));
    } finally { setSavingEdit(false); }
  };

  const fmtDate = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString(lang, {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  const isWeekendDate = (iso: string) => {
    const d = new Date(`${iso}T00:00:00`).getDay();
    return d === 0 || d === 6;
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Spinner size="lg" /></div>;

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-white">{t('calendar.title')}</h1>
        <p className="text-gray-500 text-sm mt-0.5">{t('calendar.subtitle')}</p>
      </div>

      {!canEdit && (
        <div className="p-3 bg-blue-500/10 border border-blue-500/25 rounded-lg">
          <p className="text-blue-300 text-sm">{t('calendar.viewOnly')}</p>
        </div>
      )}
      {err && (
        <div className="flex items-center gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <X size={14} className="text-red-400" /><p className="text-red-400 text-sm">{err}</p>
        </div>
      )}
      {saved && (
        <div className="flex items-center gap-2.5 p-3 bg-green-500/10 border border-green-500/25 rounded-lg">
          <Check size={14} className="text-green-400" /><p className="text-green-400 text-sm">{t('common.saved')}</p>
        </div>
      )}

      {/* Weekends */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2">
          <CalendarDays size={16} className="text-blue-400" />
          <h3 className="text-sm font-semibold text-gray-200">{t('calendar.weekendTitle')}</h3>
        </div>
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input type="checkbox" checked={data?.count_weekends ?? false} disabled={!canEdit || savingToggle}
            onChange={(e) => toggleWeekends(e.target.checked)}
            className="mt-0.5 w-4 h-4 rounded bg-gray-700 border-gray-600 text-blue-500 cursor-pointer disabled:cursor-not-allowed" />
          <span>
            <span className="text-sm text-gray-200 flex items-center gap-2">
              {t('calendar.countWeekends')}
              {savingToggle && <Loader2 size={13} className="animate-spin text-gray-500" />}
            </span>
            <span className="block text-xs text-gray-500 mt-1">{t('calendar.weekendHint')}</span>
          </span>
        </label>
      </div>

      {/* Holidays */}
      <div className="bg-[#0d1421] border border-white/[0.06] rounded-xl p-5 space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <CalendarOff size={16} className="text-amber-400" />
            <h3 className="text-sm font-semibold text-gray-200">{t('calendar.holidaysTitle')}</h3>
          </div>
          <p className="text-xs text-gray-500 mt-1">{t('calendar.holidaysHint')}</p>
        </div>

        {canEdit && (
          <div className="flex items-center gap-2 flex-wrap">
            <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)}
              className="bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500" />
            <input value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
              placeholder={t('calendar.holidayName')}
              className="bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 w-64" />
            <button onClick={handleAdd} disabled={busy || !newDate}
              className="btn-secondary py-1.5 px-3 text-sm disabled:opacity-40">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t('common.add')}
            </button>
          </div>
        )}

        {!data || data.holidays.length === 0 ? (
          <p className="text-gray-600 text-sm">{t('calendar.noHolidays')}</p>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {data.holidays.map((h) => (
                editId === h.id ? (
                  <tr key={h.id} className="border-t border-white/[0.04] bg-white/[0.02]">
                    <td className="py-2 pr-4">
                      <input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)}
                        className="bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500" />
                    </td>
                    <td className="py-2 px-3" colSpan={2}>
                      <input value={editName} onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleEditSave(); if (e.key === 'Escape') cancelEdit(); }}
                        placeholder={t('calendar.holidayName')} autoFocus
                        className="bg-[#0b1120] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 w-64" />
                    </td>
                    <td className="py-2 pl-3 text-right whitespace-nowrap">
                      <button onClick={handleEditSave} disabled={savingEdit || !editDate}
                        className="text-gray-500 hover:text-green-400 transition-colors disabled:opacity-40 mr-3" title={t('common.save')}>
                        {savingEdit ? <Loader2 size={14} className="animate-spin" /> : <Check size={15} />}
                      </button>
                      <button onClick={cancelEdit} className="text-gray-600 hover:text-gray-300 transition-colors" title={t('common.cancel')}>
                        <X size={15} />
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={h.id} className="border-t border-white/[0.04] hover:bg-white/[0.02]">
                    <td className="py-2 pr-4 text-gray-200 capitalize">{fmtDate(h.date)}</td>
                    <td className="py-2 px-3 text-gray-400">{h.name || '—'}</td>
                    <td className="py-2 px-3 text-right">
                      {isWeekendDate(h.date) && (
                        <span className="text-[10px] text-gray-600 uppercase tracking-wide">{t('calendar.weekendTag')}</span>
                      )}
                    </td>
                    <td className="py-2 pl-3 text-right whitespace-nowrap w-16">
                      {canEdit && (
                        <>
                          <button onClick={() => startEdit(h.id, h.date, h.name)}
                            className="text-gray-600 hover:text-blue-400 transition-colors mr-3" title={t('common.edit')}>
                            <Pencil size={14} />
                          </button>
                          <button onClick={() => handleDelete(h.id)}
                            className="text-gray-600 hover:text-red-400 transition-colors" title={t('common.delete')}>
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-gray-600">{t('calendar.effectNote')}</p>
    </div>
  );
}
