import { useEffect, useState } from 'react'
import { userManagement } from '../api'

const ROLES = ['candidate', 'recruiter', 'hiring_manager', 'interviewer', 'admin']

function roleBadgeColor(role) {
  return {
    admin: '#7c3aed',
    recruiter: '#0e7490',
    hiring_manager: '#b45309',
    interviewer: '#059669',
    candidate: '#6b7280',
  }[role] || '#6b7280'
}

export default function UserManagement() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [updatingId, setUpdatingId] = useState(null)

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true); setError('')
    try {
      const data = await userManagement.list()
      setUsers(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e?.message || 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }

  async function changeRole(id, role) {
    setUpdatingId(id)
    try {
      await userManagement.updateRole(id, role)
      setUsers(prev => prev.map(u => u.id === id ? { ...u, role } : u))
      setMessage('Role updated')
      setTimeout(() => setMessage(''), 3000)
    } catch (e) {
      setError(e?.message || 'Failed to update role')
    } finally {
      setUpdatingId(null)
    }
  }

  async function toggleActive(user) {
    setUpdatingId(user.id)
    try {
      await userManagement.setActive(user.id, !user.is_active)
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, is_active: !u.is_active } : u))
    } catch (e) {
      setError(e?.message || 'Failed to update user')
    } finally {
      setUpdatingId(null)
    }
  }

  const filtered = users.filter(u => {
    const q = search.toLowerCase()
    return !q || u.email?.toLowerCase().includes(q) || u.full_name?.toLowerCase().includes(q) || u.role?.includes(q)
  })

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">Administration</p>
            <h1 className="page-title">User Management</h1>
            <p className="page-subtitle">Manage user roles and access levels across the platform.</p>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}

        <article className="card">
          <div className="card-header">
            <div className="card-title">All Users</div>
            <input
              className="input"
              placeholder="Search by name, email or role…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: 260 }}
            />
          </div>
          {loading ? (
            <div style={{ padding: '2rem', textAlign: 'center' }}><span className="loading-spinner" /></div>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(u => (
                    <tr key={u.id}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <div style={{
                            width: 32, height: 32, borderRadius: '50%',
                            background: `${roleBadgeColor(u.role)}22`,
                            color: roleBadgeColor(u.role),
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontWeight: 700, fontSize: '0.85rem',
                          }}>
                            {(u.full_name || u.email || '?').charAt(0).toUpperCase()}
                          </div>
                          <span>{u.full_name || '—'}</span>
                        </div>
                      </td>
                      <td style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>{u.email}</td>
                      <td>
                        <span style={{
                          display: 'inline-block', padding: '2px 10px',
                          borderRadius: 999, fontSize: '0.78rem', fontWeight: 600,
                          background: `${roleBadgeColor(u.role)}22`,
                          color: roleBadgeColor(u.role),
                        }}>{u.role}</span>
                      </td>
                      <td>
                        <span style={{
                          color: u.is_active ? '#059669' : '#e11d48',
                          fontWeight: 600, fontSize: '0.85rem',
                        }}>{u.is_active ? 'Active' : 'Inactive'}</span>
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                          <select
                            className="input"
                            value={u.role}
                            disabled={updatingId === u.id}
                            onChange={e => changeRole(u.id, e.target.value)}
                            style={{ padding: '0.25rem 0.5rem', fontSize: '0.82rem', width: 140 }}
                          >
                            {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                          </select>
                          <button
                            type="button"
                            className={`btn btn-sm ${u.is_active ? 'btn-ghost' : 'btn-primary'}`}
                            disabled={updatingId === u.id}
                            onClick={() => toggleActive(u)}
                          >
                            {u.is_active ? 'Deactivate' : 'Activate'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filtered.length === 0 && (
                    <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>No users found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>
    </main>
  )
}
