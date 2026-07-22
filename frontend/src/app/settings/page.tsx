"use client";

// Settings: app-wide preferences, stored as a single row (app_settings, id = 1)
// behind GET/PUT /api/settings.
//
// Today this is just the default sale length. A scan that reads a sale price but
// no printed end date has to assume SOME duration, otherwise the discounted price
// would be quoted as current forever — this is that assumption, and it's here so
// it's a visible choice rather than a constant buried in the backend. Individual
// prices override it per item during inbox review, or in the price editor.

import React, { useState, useEffect, useCallback } from 'react';
import StatusToast, { useToast } from '../../components/StatusToast';
import { Label } from '../../components/ui/label';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// Preset durations covering how grocery sales actually run, so the common cases
// are one click instead of arithmetic.
const PRESETS = [
  { days: 3, label: '3 days', hint: 'Weekend special' },
  { days: 7, label: '1 week', hint: 'Typical flyer cycle' },
  { days: 14, label: '2 weeks', hint: 'Longer promotion' },
  { days: 30, label: '1 month', hint: 'Monthly / seasonal' },
];

export default function Settings() {
  const [days, setDays] = useState<string>('7');
  const [savedDays, setSavedDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { statusMsg, notify } = useToast();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/settings`);
      if (res.ok) {
        const s = await res.json();
        setDays(String(s.default_sale_days));
        setSavedDays(Number(s.default_sale_days));
      }
    } catch { /* ignore transient */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (value?: number) => {
    const n = value ?? parseInt(days, 10);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      notify('Enter a whole number of days between 1 and 365.', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_sale_days: n }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || 'Failed to save.');
      setDays(String(body.default_sale_days));
      setSavedDays(Number(body.default_sale_days));
      notify('Settings saved.');
    } catch (err: any) {
      notify(err?.message || 'Failed to save settings.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const parsed = parseInt(days, 10);
  const preview = Number.isInteger(parsed) && parsed > 0 && parsed <= 365
    ? new Date(Date.now() + parsed * 86400000).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
    : null;
  const dirty = savedDays != null && parsed !== savedDays;

  return (
    <div data-loc="page.settings" className="space-y-8 max-w-3xl mx-auto">
      <StatusToast statusMsg={statusMsg} />

      {/* ═══ Section: Header ═══ */}
      <div data-loc="settings.header">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-slate-400 mt-1">App-wide preferences. These apply to every scan and price you record.</p>
      </div>

      {/* ═══ Section: Default sale duration ═══ */}
      <Card data-loc="settings.sale-duration" className="rounded-3xl p-6 space-y-5">
        <div>
          <h2 className="text-lg font-bold text-white">Default sale duration</h2>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">
            When a scan finds a <span className="text-rose-300 font-semibold">sale price</span> but the receipt or tag
            doesn&apos;t say when the sale ends, it&apos;s assumed to run this long. Once a sale expires its price stops
            counting as current — it disappears from the dashboard, best-price comparisons and meal costs, though
            History keeps it. You can override the date on any individual price while reviewing a scan.
          </p>
        </div>

        {loading ? (
          <p className="text-slate-600 text-sm py-4 text-center">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {PRESETS.map(p => (
                <Button key={p.days} onClick={() => { setDays(String(p.days)); save(p.days); }}
                  disabled={saving}
                  title={p.hint}
                  variant={savedDays === p.days ? 'default' : 'secondary'}>
                  {p.label}
                </Button>
              ))}
            </div>

            <div className="bg-muted/50 border rounded-lg p-4 space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <Label htmlFor="sale-days">Custom duration (days)</Label>
                  <input id="sale-days" type="number" min={1} max={365} value={days}
                    onChange={e => setDays(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') save(); }}
                    className="field-input w-32" />
                </div>
                <Button onClick={() => save()} disabled={saving || !dirty}>
                  {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
                </Button>
              </div>
              {preview && (
                <p className="text-xs text-slate-400">
                  A sale scanned today with no printed end date would expire on{' '}
                  <span className="text-white font-semibold">{preview}</span>.
                </p>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
