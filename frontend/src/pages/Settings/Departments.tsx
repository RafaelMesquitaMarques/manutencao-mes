import { useState, useEffect, useCallback } from 'react';
import { FolderTree, Plus, Trash2, Check, X, RefreshCw, Pencil, EyeOff, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  fetchDepartments, createDepartment, updateDepartment, deleteDepartment,
  type Department,
} from '../../api/departments';
import { useAuthStore } from '../../store/authStore';

export default function DepartmentSettings() {
  const { t } = useTranslation();
  const can = useAuthStore((s) => s.can);
  const canEdit = can('settings_departments', 'update');

  const [items, setItems] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    fetchDepartments(true).then(setItems).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const add = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setError('');
    try { await createDepartment(name); setNewName(''); load(); }
    catch (e: any) { setError(e?.response?.data?.detail ?? t('common.saveError', 'Error')); }
    finally { setBusy(false); }
  };

  const saveEdit = async (id: string) => {
    const name = editName.trim();
    if (!name) { setEditId(null); return; }
    setError('');
    try { await updateDepartment(id, { name }); setEditId(null); load(); }
    catch (e: any) { setError(e?.response?.data?.detail ?? t('common.saveError', 'Error')); }
  };

  const toggleActive = async (d: Department) => {
    await updateDepartment(d.id, { is_active: !d.is_active }); load();
  };

  const remove = async (d: Department) => {
    if (!window.confirm(t('departments.confirmDelete', { name: d.name }))) return;
    setError('');
    try { await deleteDepartment(d.id); load(); }
    catch (e: any) { setError(e?.response?.data?.detail ?? t('common.saveError', 'Error')); }
  };

  return (
    <div className="flex flex-col bg-gray-950 text-gray-100 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-gray-800">
        <div>
          <h1 className="text-xl font-semibold text-white flex items-center gap-2">
            <FolderTree size={20} className="text-indigo-400" />
            {t('departments.title')}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {items.length} {t('departments.count')}
          </p>
        </div>
        <button onClick={load} className="p-2 text-gray-500 hover:text-gray-300 hover:bg-gray-800 rounded-lg">
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="max-w-2xl w-full px-6 py-5 space-y-4">
        <p className="text-sm text-gray-500">{t('departments.subtitle')}</p>

        {/* Add */}
        {canEdit && (
          <div className="flex items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder={t('departments.addPlaceholder')}
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-indigo-500"
            />
            <button
              onClick={add}
              disabled={busy || !newName.trim()}
              className="flex items-center gap-1.5 px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg disabled:opacity-40"
            >
              <Plus size={15} /> {t('departments.add')}
            </button>
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}

        {/* List */}
        {loading && items.length === 0 ? (
          <p className="text-sm text-gray-600 py-8 text-center">{t('common.loading', 'Loading…')}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-gray-600 py-8 text-center">{t('departments.empty')}</p>
        ) : (
          <div className="border border-gray-800 rounded-xl divide-y divide-gray-800/70 overflow-hidden">
            {items.map((d) => (
              <div key={d.id} className={`flex items-center gap-3 px-4 py-2.5 ${d.is_active ? '' : 'opacity-50'}`}>
                {editId === d.id ? (
                  <>
                    <input
                      value={editName}
                      autoFocus
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(d.id); if (e.key === 'Escape') setEditId(null); }}
                      className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-indigo-500"
                    />
                    <button onClick={() => saveEdit(d.id)} className="text-green-400 hover:text-green-300"><Check size={16} /></button>
                    <button onClick={() => setEditId(null)} className="text-gray-500 hover:text-gray-300"><X size={16} /></button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm text-gray-200">{d.name}</span>
                    {!d.is_active && <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded px-1.5 py-0.5">{t('departments.inactive')}</span>}
                    {canEdit && (
                      <div className="flex items-center gap-2">
                        <button onClick={() => { setEditId(d.id); setEditName(d.name); }} title={t('departments.rename')} className="text-gray-500 hover:text-gray-200"><Pencil size={14} /></button>
                        <button onClick={() => toggleActive(d)} title={d.is_active ? t('departments.deactivate') : t('departments.activate')} className="text-gray-500 hover:text-gray-200">{d.is_active ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                        <button onClick={() => remove(d)} title={t('common.delete', 'Delete')} className="text-red-500/70 hover:text-red-400"><Trash2 size={14} /></button>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
