import { useState, useEffect } from 'react'
import { requisitions, departments } from '../api'

const STATUS_COLORS = {
  draft: '#6b7280',
  submitted: '#d97706',
  approved: '#059669',
  rejected: '#dc2626',
}

const STATUS_LABELS = { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected' }

const emptyForm = {
  department_id: '',
  job_title: '',
  justification: '',
  headcount: 1,
  employment_type: 'Full-time',
  salary_budget_min: '',
  salary_budget_max: '',
  salary_currency: 'INR',
  requested_by_name: '',
  requested_by_email: '',
}

export default function Requisitions() {
  const token = localStorage.getItem('token')
  const [list, setList] = useState([])
  const [deptList, setDeptList] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [editId, setEditId] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actionLoading, setActionLoading] = useState(null)
  const [approverNote, setApproverNote] = useState('')
  const [noteFor, setNoteFor] = useState(null)

  useEffect(() => {
    loadAll()
    loadDepts()
  }, [filter])

  async function loadAll() {
    setLoading(true); setError('')
    try {
      const data = await requisitions.list(token, filter || undefined)
      setList(Array.isArray(data) ? data : [])
    } catch { setError('Failed to load requisitions') }
    finally { setLoading(false) }
  }

  async function loadDepts() {
    try { setDeptList(await departments.list(token)) } catch {}
  }

  function deptName(id) { return deptList.find(d => d.id === id)?.name || '—' }

  function openNew() { setForm(emptyForm); setEditId(null); setShowForm(true) }
  function openEdit(r) {
    setForm({
      department_id: r.department_id || '',
      job_title: r.job_title,
      justification: r.justification || '',
      headcount: r.headcount,
      employment_type: r.employment_type || 'Full-time',
      salary_budget_min: r.salary_budget_min || '',
      salary_budget_max: r.salary_budget_max || '',
      salary_currency: r.salary_currency || 'INR',
      requested_by_name: r.requested_by_name || '',
      requested_by_email: r.requested_by_email || '',
    })
    setEditId(r.id); setShowForm(true)
  }
  function cancelForm() { setShowForm(false); setEditId(null); setForm(emptyForm) }

  function fv(v) { return v === '' ? undefined : v }
  function fn(v) { const n = parseFloat(v); return isNaN(n) ? undefined : n }

  async function save(e) {
    e.preventDefault()
    setSaving(true)
    const payload = {
      department_id: fv(form.department_id) ? parseInt(form.department_id) : null,
      job_title: form.job_title.trim(),
      justification: fv(form.justification),
      headcount: parseInt(form.headcount) || 1,
      employment_type: fv(form.employment_type),
      salary_budget_min: fn(form.salary_budget_min),
      salary_budget_max: fn(form.salary_budget_max),
      salary_currency: form.salary_currency || 'INR',
      requested_by_name: fv(form.requested_by_name),
      requested_by_email: fv(form.requested_by_email),
    }
    try {
      if (editId) {
        const updated = await requisitions.update(token, editId, payload)
        setList(list.map(r => r.id === editId ? updated : r))
      } else {
        const created = await requisitions.create(token, payload)
        setList([created, ...list])
      }
      cancelForm()
    } catch (err) { setError(err?.message || 'Failed to save') }
    finally { setSaving(false) }
  }

  async function doAction(action, reqId) {
    setActionLoading(reqId + action)
    try {
      let updated
      if (action === 'submit') updated = await requisitions.submit(token, reqId)
      else if (action === 'approve') { updated = await requisitions.approve(token, reqId, approverNote); setNoteFor(null); setApproverNote('') }
      else if (action === 'reject') { updated = await requisitions.reject(token, reqId, approverNote); setNoteFor(null); setApproverNote('') }
      if (updated) setList(list.map(r => r.id === reqId ? updated : r))
    } catch (err) { setError(err?.message || `Failed to ${action}`) }
    finally { setActionLoading(null) }
  }

  async function remove(id) {
    if (!window.confirm('Delete this requisition?')) return
    try {
      await requisitions.delete(token, id)
      setList(list.filter(r => r.id !== id))
    } catch { setError('Failed to delete') }
  }

  const fmt = n => n != null ? Number(n).toLocaleString('en-IN') : null

  return (
    <main className="page-content" style={{ maxWidth: 900, margin: '0 auto', padding: '2rem 1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>Hire Requisitions</h1>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Raise, approve, and track headcount requests before creating jobs
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <select className="form-input" style={{ width: 'auto' }} value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="">All Status</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
          <button className="btn btn-primary" onClick={openNew}>+ New Requisition</button>
        </div>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {showForm && (
        <div className="card" style={{ marginBottom: '1.5rem', padding: '1.5rem' }}>
          <h2 style={{ margin: '0 0 1rem', fontSize: '1.1rem', fontWeight: 600 }}>{editId ? 'Edit Requisition' : 'New Hire Requisition'}</h2>
          <form onSubmit={save}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">Job Title *</label>
                <input className="form-input" required value={form.job_title} onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} placeholder="e.g. Senior Backend Engineer" />
              </div>
              <div>
                <label className="form-label">Department</label>
                <select className="form-input" value={form.department_id} onChange={e => setForm(f => ({ ...f, department_id: e.target.value }))}>
                  <option value="">Select department…</option>
                  {deptList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">Headcount</label>
                <input className="form-input" type="number" min={1} max={100} value={form.headcount} onChange={e => setForm(f => ({ ...f, headcount: e.target.value }))} />
              </div>
              <div>
                <label className="form-label">Employment Type</label>
                <select className="form-input" value={form.employment_type} onChange={e => setForm(f => ({ ...f, employment_type: e.target.value }))}>
                  <option>Full-time</option><option>Part-time</option><option>Contract</option><option>Internship</option>
                </select>
              </div>
              <div>
                <label className="form-label">Currency</label>
                <select className="form-input" value={form.salary_currency} onChange={e => setForm(f => ({ ...f, salary_currency: e.target.value }))}>
                  <option>INR</option><option>USD</option><option>GBP</option><option>EUR</option>
                </select>
              </div>
              <div>
                <label className="form-label">Budget Min ({form.salary_currency})</label>
                <input className="form-input" type="number" min={0} value={form.salary_budget_min} onChange={e => setForm(f => ({ ...f, salary_budget_min: e.target.value }))} placeholder="e.g. 800000" />
              </div>
              <div>
                <label className="form-label">Budget Max ({form.salary_currency})</label>
                <input className="form-input" type="number" min={0} value={form.salary_budget_max} onChange={e => setForm(f => ({ ...f, salary_budget_max: e.target.value }))} placeholder="e.g. 1200000" />
              </div>
              <div>
                <label className="form-label">Requested By</label>
                <input className="form-input" value={form.requested_by_name} onChange={e => setForm(f => ({ ...f, requested_by_name: e.target.value }))} placeholder="Manager name" />
              </div>
              <div>
                <label className="form-label">Requester Email</label>
                <input className="form-input" type="email" value={form.requested_by_email} onChange={e => setForm(f => ({ ...f, requested_by_email: e.target.value }))} placeholder="manager@company.com" />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">Business Justification</label>
                <textarea className="form-input" rows={3} value={form.justification} onChange={e => setForm(f => ({ ...f, justification: e.target.value }))} placeholder="Why is this hire needed? (team growth, replacement, new project…)" />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
              <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : editId ? 'Update' : 'Save as Draft'}</button>
              <button className="btn btn-ghost" type="button" onClick={cancelForm}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>Loading…</div>
      ) : list.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>📋</div>
          <p>No requisitions yet. Create one to start the hiring process.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {list.map(r => (
            <div key={r.id} className="card" style={{ padding: '1rem 1.25rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: '1rem' }}>{r.job_title}</span>
                    <span style={{ fontSize: '0.75rem', fontWeight: 600, padding: '0.2rem 0.6rem', borderRadius: 20, background: STATUS_COLORS[r.status] + '22', color: STATUS_COLORS[r.status] }}>
                      {STATUS_LABELS[r.status] || r.status}
                    </span>
                  </div>
                  <div style={{ marginTop: '0.4rem', fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                    {r.department_id && <span>🏢 {deptName(r.department_id)}</span>}
                    <span>👥 {r.headcount} head{r.headcount !== 1 ? 's' : ''}</span>
                    {r.employment_type && <span>⏱ {r.employment_type}</span>}
                    {r.salary_budget_min && <span>💰 {r.salary_currency} {fmt(r.salary_budget_min)}{r.salary_budget_max ? ` – ${fmt(r.salary_budget_max)}` : '+'}</span>}
                  </div>
                  {r.requested_by_name && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>By: {r.requested_by_name}{r.requested_by_email ? ` (${r.requested_by_email})` : ''}</div>}
                  {r.justification && <div style={{ fontSize: '0.83rem', marginTop: '0.4rem', color: 'var(--text-secondary)' }}>{r.justification}</div>}
                  {r.approver_notes && <div style={{ fontSize: '0.83rem', marginTop: '0.3rem', color: STATUS_COLORS[r.status] }}>Note: {r.approver_notes}</div>}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0, flexWrap: 'wrap' }}>
                  {r.status === 'draft' && (
                    <>
                      <button className="btn btn-ghost btn-sm" onClick={() => openEdit(r)}>Edit</button>
                      <button className="btn btn-primary btn-sm" disabled={actionLoading === r.id + 'submit'} onClick={() => doAction('submit', r.id)}>Submit</button>
                    </>
                  )}
                  {r.status === 'submitted' && (
                    <>
                      {noteFor === r.id ? (
                        <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                          <input className="form-input" style={{ width: 160, padding: '0.3rem 0.6rem', fontSize: '0.85rem' }} placeholder="Approver note…" value={approverNote} onChange={e => setApproverNote(e.target.value)} />
                          <button className="btn btn-primary btn-sm" onClick={() => doAction('approve', r.id)} disabled={actionLoading === r.id + 'approve'}>Confirm ✓</button>
                          <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => doAction('reject', r.id)} disabled={actionLoading === r.id + 'reject'}>Reject ✗</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => { setNoteFor(null); setApproverNote('') }}>Cancel</button>
                        </div>
                      ) : (
                        <button className="btn btn-primary btn-sm" onClick={() => setNoteFor(r.id)}>Review</button>
                      )}
                    </>
                  )}
                  {r.status !== 'draft' && <button className="btn btn-ghost btn-sm" onClick={() => openEdit(r)}>Edit</button>}
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => remove(r.id)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
