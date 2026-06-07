import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createSupplier } from '../../api/suppliers';

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-purple-500';
const CATEGORIES = ['Parts', 'Tools', 'Raw Materials', 'Electrical', 'Safety', 'Services', 'Other'];
const CURRENCIES = ['CAD', 'USD', 'EUR'];
const TERMS      = ['Net 30', 'Net 60', 'Net 90', 'Prepaid', 'COD'];

function FormField({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1.5">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

export default function NewSupplier() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    code: '',
    name: '',
    contact_name: '',
    email: '',
    phone: '',
    fax: '',
    website: '',
    address: '',
    city: '',
    country: '',
    category: '',
    currency: 'CAD',
    payment_terms: '',
    lead_time_days: '',
    notes: '',
  });

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const sup = await createSupplier({
        code:          form.code || undefined,
        name:          form.name,
        contact_name:  form.contact_name || undefined,
        email:         form.email || undefined,
        phone:         form.phone || undefined,
        fax:           form.fax || undefined,
        website:       form.website || undefined,
        address:       form.address || undefined,
        city:          form.city || undefined,
        country:       form.country || undefined,
        category:      form.category || undefined,
        currency:      form.currency,
        payment_terms: form.payment_terms || undefined,
        lead_time_days: form.lead_time_days ? parseInt(form.lead_time_days) : undefined,
        notes:         form.notes || undefined,
      });
      navigate(`/suppliers/${sup.id}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-gray-950 text-gray-100 pb-12">
      <div className="sticky top-0 z-10 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-6 py-3 flex items-center gap-3">
        <button onClick={() => navigate('/suppliers')} className="p-1.5 hover:bg-gray-800 rounded-lg text-gray-400 hover:text-gray-200">
          <ArrowLeft size={18} />
        </button>
        <span className="text-gray-500">/</span>
        <span className="text-sm text-gray-300 font-medium">{t('suppliers.title', 'Suppliers')}</span>
        <span className="text-gray-500">/</span>
        <span className="text-sm text-gray-300">{t('suppliers.newSupplier', 'New Supplier')}</span>
      </div>

      <div className="max-w-2xl mx-auto px-6 pt-8">
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Identity */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-2">{t('suppliers.identification', 'Identification')}</h2>
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('suppliers.code', 'Supplier code')}>
                <input value={form.code} onChange={e => set('code', e.target.value)} placeholder="SUP-XXX" className={inputCls} />
              </FormField>
              <FormField label={t('suppliers.category', 'Category')}>
                <select value={form.category} onChange={e => set('category', e.target.value)} className={inputCls}>
                  <option value="">— None —</option>
                  {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </FormField>
            </div>
            <FormField label={t('suppliers.name', 'Company name')} required>
              <input required value={form.name} onChange={e => set('name', e.target.value)} placeholder="Company name" className={inputCls} />
            </FormField>
          </div>

          {/* Contact */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-2">{t('suppliers.contactInfo', 'Contact')}</h2>
            <FormField label={t('suppliers.contact', 'Contact name')}>
              <input value={form.contact_name} onChange={e => set('contact_name', e.target.value)} className={inputCls} />
            </FormField>
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('suppliers.email', 'Email')}>
                <input type="email" value={form.email} onChange={e => set('email', e.target.value)} className={inputCls} />
              </FormField>
              <FormField label={t('suppliers.phone', 'Phone')}>
                <input value={form.phone} onChange={e => set('phone', e.target.value)} className={inputCls} />
              </FormField>
              <FormField label="Fax">
                <input value={form.fax} onChange={e => set('fax', e.target.value)} className={inputCls} />
              </FormField>
              <FormField label="Website">
                <input value={form.website} onChange={e => set('website', e.target.value)} placeholder="https://" className={inputCls} />
              </FormField>
            </div>
          </div>

          {/* Address */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-2">{t('suppliers.address', 'Address')}</h2>
            <FormField label={t('suppliers.addressLine', 'Street address')}>
              <input value={form.address} onChange={e => set('address', e.target.value)} className={inputCls} />
            </FormField>
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('suppliers.city', 'City')}>
                <input value={form.city} onChange={e => set('city', e.target.value)} className={inputCls} />
              </FormField>
              <FormField label={t('suppliers.country', 'Country')}>
                <input value={form.country} onChange={e => set('country', e.target.value)} className={inputCls} />
              </FormField>
            </div>
          </div>

          {/* Commercial */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-300 mb-2">{t('suppliers.commercial', 'Commercial Terms')}</h2>
            <div className="grid grid-cols-3 gap-4">
              <FormField label={t('suppliers.currency', 'Currency')}>
                <select value={form.currency} onChange={e => set('currency', e.target.value)} className={inputCls}>
                  {CURRENCIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </FormField>
              <FormField label={t('suppliers.paymentTerms', 'Payment terms')}>
                <select value={form.payment_terms} onChange={e => set('payment_terms', e.target.value)} className={inputCls}>
                  <option value="">— None —</option>
                  {TERMS.map(t => <option key={t}>{t}</option>)}
                </select>
              </FormField>
              <FormField label={t('suppliers.leadTime', 'Lead time (days)')}>
                <input type="number" min="0" value={form.lead_time_days} onChange={e => set('lead_time_days', e.target.value)} className={inputCls} placeholder="—" />
              </FormField>
            </div>
          </div>

          {/* Notes */}
          <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
            <FormField label={t('common.notes', 'Notes')}>
              <textarea value={form.notes} onChange={e => set('notes', e.target.value)} rows={3} className={inputCls} placeholder="Internal notes…" />
            </FormField>
          </div>

          <div className="flex justify-end gap-3 pb-4">
            <button type="button" onClick={() => navigate('/suppliers')} className="px-4 py-2 text-sm text-gray-300 bg-gray-800 border border-gray-700 hover:bg-gray-700 rounded-lg">
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={saving} className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-purple-600 hover:bg-purple-500 rounded-lg disabled:opacity-50">
              <Save size={14} /> {saving ? t('common.saving', 'Saving…') : t('suppliers.createSupplier', 'Create Supplier')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
