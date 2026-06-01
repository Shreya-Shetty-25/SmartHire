import { useState, useEffect } from 'react'
import { departments } from '../api'

const emptyForm = { name: '', description: '', head_name: '' }

export default function Departments() {
  const token = null
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [form, setForm] = useState(emptyForm)
  const [editId, setEditId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [showForm, setShowForm] = useState(false)

  useEffect(() => { loadDepts() }, [])

  async function loadDepts() {
    setLoading(true)
    setError('')
    try {
      const data = await departments.list(token)
      setList(Array.isArray(data) ? data : [])
    } catch { setError('Failed to load departments') }
    finally { setLoading(false) }
  }

  function openNew() { setForm(emptyForm); setEditId(null); setShowForm(true) }

  function openEdit(d) {
    setForm({ name: d.name, description: d.description || '', head_name: d.head_name || '' })
    setEditId(d.id)
    setShowForm(true)
  }

  function cancelForm() { setShowForm(false); setEditId(null); setForm(emptyForm) }

  async function save(e) {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    try {
      if (editId) {
        const updated = await departments.update(token, editId, form)
        setList(list.map(d => d.id === editId ? updated : d))
      } else {
        const created = await departments.create(token, form)
        setList([created, ...list])
      }
      cancelForm()
    } catch (err) {
      setError(err?.message || 'Failed to save department')
    } finally { setSaving(false) }
  }

  async function remove(id) {
    if (!window.confirm('Delete this department?')) return
    try {
      await departments.delete(token, id)
      setList(list.filter(d => d.id !== id))
    } catch { setError('Failed to delete department') }
  }

  return (
    <main className="page-content" style={{ maxWidth: 800, margin: '0 auto', padding: '2rem 1rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>Departments</h1>
          <p style={{ margin: '0.25rem 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            Manage org departments linked to jobs and requisitions
          </p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>+ New Department</button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '1rem' }}>{error}</div>}

      {showForm && (
        <div className="card" style={{ marginBottom: '1.5rem', padding: '1.5rem' }}>
          <h2 style={{ margin: '0 0 1rem', fontSize: '1.1rem', fontWeight: 600 }}>
            {editId ? 'Edit Department' : 'New Department'}
          </h2>
          <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div>
              <label className="form-label">Department Name *</label>
              <input className="form-input" value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Engineering" required />
            </div>
            <div>
              <label className="form-label">Head / Manager</label>
              <input className="form-input" value={form.head_name}
                onChange={e => setForm(f => ({ ...f, head_name: e.target.value }))}
                placeholder="e.g. Priya Sharma" />
            </div>
            <div>
              <label className="form-label">Description</label>
              <textarea className="form-input" rows={2} value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Brief description of this department" />
            </div>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button className="btn btn-primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : editId ? 'Update' : 'Create'}
              </button>
              <button className="btn btn-ghost" type="button" onClick={cancelForm}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>Loading…</div>
      ) : list.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '2.5rem', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🏢</div>
          <p>No departments yet. Create one to start organising jobs.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {list.map(d => (
            <div key={d.id} className="card" style={{ padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '1rem' }}>{d.name}</div>
                {d.head_name && <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>Head: {d.head_name}</div>}
                {d.description && <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>{d.description}</div>}
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => openEdit(d)}>Edit</button>
                <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => remove(d.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  )
}
