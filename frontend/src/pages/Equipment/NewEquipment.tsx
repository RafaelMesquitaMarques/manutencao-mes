import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, AlertCircle } from 'lucide-react';
import api from '../../api/axios';
import Spinner from '../../components/ui/Spinner';

interface Plant {
  id: string;
  code: string;
  name: string;
}

interface FormState {
  plant_id: string;
  code: string;
  name: string;
  location: string;
  criticality: string;
  manufacturer: string;
  serial_number: string;
  description: string;
  asset_type: 'production' | 'auxiliary';
  subtype: string;
}

const CRITICALITIES = ['low', 'medium', 'high', 'critical'];

export default function NewEquipment() {
  const navigate = useNavigate();
  const [plants, setPlants] = useState<Plant[]>([]);
  const [loadingPlants, setLoadingPlants] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>({
    plant_id: '',
    code: '',
    name: '',
    location: '',
    criticality: 'medium',
    manufacturer: '',
    serial_number: '',
    description: '',
    asset_type: 'production',
    subtype: '',
  });

  useEffect(() => {
    api.get<Plant[]>('/api/plants/')
      .then(({ data }) => {
        setPlants(data);
        if (data.length === 1) setForm((f) => ({ ...f, plant_id: data[0].id }));
      })
      .catch(() => {})
      .finally(() => setLoadingPlants(false));
  }, []);

  const set = (field: keyof FormState, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.plant_id || !form.code || !form.name) {
      setError('Plant, code, and name are required.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await api.post('/api/equipment/', {
        plant_id: form.plant_id,
        code: form.code.trim(),
        name: form.name.trim(),
        location: form.location.trim() || undefined,
        criticality: form.criticality,
        manufacturer: form.manufacturer.trim() || undefined,
        serial_number: form.serial_number.trim() || undefined,
        description: form.description.trim() || undefined,
        asset_type: form.asset_type,
        subtype: form.asset_type === 'auxiliary' ? (form.subtype.trim() || undefined) : undefined,
      });
      navigate(`/equipment/${data.id}`);
    } catch (err: any) {
      setError(err?.response?.data?.detail ?? 'Failed to create equipment.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5 animate-fade-in max-w-2xl">
      <div>
        <button
          onClick={() => navigate('/equipment')}
          className="flex items-center gap-1.5 text-gray-500 hover:text-gray-300 transition-colors text-sm mb-4"
        >
          <ArrowLeft size={15} />
          Equipment
        </button>
        <h1 className="text-2xl font-bold text-white">New Equipment</h1>
        <p className="text-gray-500 text-sm mt-1">Register a new asset in the equipment catalog</p>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 p-3 bg-red-500/10 border border-red-500/25 rounded-lg">
          <AlertCircle size={15} className="text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="glass-card p-5 space-y-4">
          <h2 className="text-white font-medium text-sm border-b border-white/[0.06] pb-3 -mt-1">
            General Information
          </h2>

          <div>
            <label className="label">Plant *</label>
            <select
              className="input-field"
              value={form.plant_id}
              onChange={(e) => set('plant_id', e.target.value)}
              required
              disabled={loadingPlants || submitting}
            >
              <option value="">{loadingPlants ? 'Loading...' : 'Select plant'}</option>
              {plants.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.code})</option>
              ))}
            </select>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Code *</label>
              <input
                type="text"
                className="input-field"
                value={form.code}
                onChange={(e) => set('code', e.target.value)}
                placeholder="e.g. EQ-004"
                required
                disabled={submitting}
              />
            </div>
            <div>
              <label className="label">Name *</label>
              <input
                type="text"
                className="input-field"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="e.g. CNC Router Line 4"
                required
                disabled={submitting}
              />
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Location</label>
              <input
                type="text"
                className="input-field"
                value={form.location}
                onChange={(e) => set('location', e.target.value)}
                placeholder="e.g. Production Line 4"
                disabled={submitting}
              />
            </div>
            <div>
              <label className="label">Criticality</label>
              <select
                className="input-field"
                value={form.criticality}
                onChange={(e) => set('criticality', e.target.value)}
                disabled={submitting}
              >
                {CRITICALITIES.map((c) => (
                  <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="label">Equipment type</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, asset_type: 'production' }))}
                disabled={submitting}
                className={`p-3 rounded border text-left transition-colors ${
                  form.asset_type === 'production' ? 'border-blue-500/60 bg-blue-500/10' : 'border-white/10 hover:border-white/20'
                }`}
              >
                <p className="text-sm font-medium text-white">Production machine</p>
                <p className="text-gray-500 text-xs mt-0.5 leading-snug">Produces output — has machine page, kiosk, MES, stops, operators.</p>
              </button>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, asset_type: 'auxiliary' }))}
                disabled={submitting}
                className={`p-3 rounded border text-left transition-colors ${
                  form.asset_type === 'auxiliary' ? 'border-teal-500/60 bg-teal-500/10' : 'border-white/10 hover:border-white/20'
                }`}
              >
                <p className="text-sm font-medium text-white">Auxiliary (utility)</p>
                <p className="text-gray-500 text-xs mt-0.5 leading-snug">Generator, compressor, HVAC, conveyor… maintenance only, no kiosk/MES.</p>
              </button>
            </div>
          </div>

          {form.asset_type === 'auxiliary' && (
            <div>
              <label className="label">Subtype</label>
              <input
                type="text"
                className="input-field"
                value={form.subtype}
                onChange={(e) => set('subtype', e.target.value)}
                placeholder="e.g. Generator, Compressor, HVAC, Conveyor"
                disabled={submitting}
              />
            </div>
          )}

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <label className="label">Manufacturer</label>
              <input
                type="text"
                className="input-field"
                value={form.manufacturer}
                onChange={(e) => set('manufacturer', e.target.value)}
                placeholder="e.g. Homag"
                disabled={submitting}
              />
            </div>
            <div>
              <label className="label">Serial Number</label>
              <input
                type="text"
                className="input-field"
                value={form.serial_number}
                onChange={(e) => set('serial_number', e.target.value)}
                placeholder="e.g. SN-2024-00123"
                disabled={submitting}
              />
            </div>
          </div>

          <div>
            <label className="label">Description</label>
            <textarea
              className="input-field resize-none"
              rows={3}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Optional notes about this asset"
              disabled={submitting}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 pt-1">
          <button
            type="button"
            onClick={() => navigate('/equipment')}
            className="btn-secondary"
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? (
              <>
                <Spinner size="xs" />
                Creating...
              </>
            ) : (
              <>
                <Plus size={15} />
                Create Equipment
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
