import { useEffect, useMemo, useState } from 'react'
import { referrals as referralsApi } from '../api'

const STATUS_COLORS = {
  pending: 'badge-yellow',
  reviewed: 'badge-blue',
  hired: 'badge-green',
  rejected: 'badge-red',
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  const diff = Date.now() - new Date(dateStr).getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

export default function AdminReferrals() {
  const token = null
  const [items, setItems] = useState([])
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filterJob, setFilterJob] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [updating, setUpdating] = useState({})

  async function loadReferrals() {
    setLoading(true)
    try {
      const data = await referralsApi.list(token, filterJob || undefined, filterStatus || undefined)
      setItems(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err?.message || 'Failed to load referrals')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    referralsApi.activeJobs().then(data => {
      setJobs(Array.isArray(data) ? data : [])
    }).catch(() => {})
  }, [])

  useEffect(() => { loadReferrals() }, [filterJob, filterStatus])

  async function updateStatus(id, newStatus) {
    setUpdating(p => ({ ...p, [id]: true }))
    try {
      await referralsApi.updateStatus(token, id, newStatus)
      setItems(prev => prev.map(r => r.id === id ? { ...r, status: newStatus } : r))
    } catch (err) {
      setError(err?.message || 'Failed to update status')
    } finally {
      setUpdating(p => ({ ...p, [id]: false }))
    }
  }

  async function deleteReferral(id) {
    if (!window.confirm('Delete this referral? This cannot be undone.')) return
    try {
      await referralsApi.delete(token, id)
      setItems(prev => prev.filter(r => r.id !== id))
    } catch (err) {
      setError(err?.message || 'Failed to delete referral')
    }
  }

  const jobsMap = useMemo(() => {
    const m = {}
    jobs.forEach(j => { m[j.id] = j.title })
    return m
  }, [jobs])

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">Sourcing</p>
            <h1 className="page-title">Referrals</h1>
            <p className="page-subtitle">Employee referrals submitted via the referral portal.</p>
          </div>
        </div>

        {error && <div className="error-banner" style={{ marginBottom: '1rem' }}>{error}</div>}

        {/* Filters */}
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
          <select className="input" style={{ maxWidth: 220 }} value={filterJob} onChange={e => setFilterJob(e.target.value)}>
            <option value="">All Roles</option>
            {jobs.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}
          </select>
          <select className="input" style={{ maxWidth: 180 }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="pending">Pending</option>
            <option value="reviewed">Reviewed</option>
            <option value="hired">Hired</option>
            <option value="rejected">Rejected</option>
          </select>
          <button className="btn btn-ghost" onClick={loadReferrals}>Refresh</button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '4rem 0' }}>
            <span className="loading-spinner" />
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            <p style={{ marginTop: '0.75rem', color: 'var(--text-secondary)' }}>No referrals found</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {items.map(ref => (
              <article key={ref.id} className="card" style={{ padding: '1.1rem 1.5rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.75rem' }}>
                  {/* Candidate & Referrer info */}
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontWeight: 700, fontSize: '1rem' }}>{ref.candidate_name}</div>
                    <div className="muted" style={{ fontSize: '0.8rem' }}>{ref.candidate_email}{ref.candidate_phone ? ` · ${ref.candidate_phone}` : ''}</div>
                    <div style={{ marginTop: '0.4rem', fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                      <span style={{ fontWeight: 500 }}>Referred by:</span> {ref.referrer_name}
                      {ref.referrer_employee_id ? ` (${ref.referrer_employee_id})` : ''}
                      {' · '}{ref.referrer_email}
                    </div>
                    {ref.relationship && (
                      <div className="muted" style={{ fontSize: '0.78rem', marginTop: '0.2rem' }}>
                        Relationship: {ref.relationship}
                      </div>
                    )}
                    {ref.note && (
                      <div style={{ marginTop: '0.5rem', fontSize: '0.82rem', color: 'var(--text-secondary)', fontStyle: 'italic', maxWidth: 440 }}>
                        "{ref.note}"
                      </div>
                    )}
                  </div>

                  {/* Right: role, status, actions */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem', flexShrink: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span className={`badge-soft ${STATUS_COLORS[ref.status] || ''}`} style={{ textTransform: 'capitalize' }}>{ref.status}</span>
                      <span className="muted" style={{ fontSize: '0.75rem' }}>{timeAgo(ref.created_at)}</span>
                    </div>
                    <div className="muted" style={{ fontSize: '0.78rem' }}>
                      {jobsMap[ref.job_id] || `Job #${ref.job_id}`}
                    </div>
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {ref.status !== 'reviewed' && (
                        <button className="btn btn-ghost btn-sm" disabled={updating[ref.id]} onClick={() => updateStatus(ref.id, 'reviewed')}>Mark Reviewed</button>
                      )}
                      {ref.status !== 'hired' && (
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--green, #22c55e)' }} disabled={updating[ref.id]} onClick={() => updateStatus(ref.id, 'hired')}>Hired</button>
                      )}
                      {ref.status !== 'rejected' && (
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} disabled={updating[ref.id]} onClick={() => updateStatus(ref.id, 'rejected')}>Reject</button>
                      )}
                      <button className="btn btn-ghost btn-sm" style={{ color: 'var(--error)' }} onClick={() => deleteReferral(ref.id)}>Delete</button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
