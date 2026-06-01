import { useEffect, useState } from 'react'
import { offers as offersApi, jobs as jobsApi, candidates as candidatesApi } from '../api'

const STATUS_COLORS = {
  pending: '#b45309',
  accepted: '#059669',
  rejected: '#e11d48',
  withdrawn: '#6b7280',
  expired: '#9ca3af',
}

function StatusBadge({ status }) {
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 999,
      fontSize: '0.78rem', fontWeight: 600,
      background: `${STATUS_COLORS[status] || '#6b7280'}22`,
      color: STATUS_COLORS[status] || '#6b7280',
    }}>{status}</span>
  )
}

export default function Offers() {
  const userRole = localStorage.getItem('userRole') || 'candidate'
  const isStaff = ['admin', 'recruiter', 'hiring_manager', 'interviewer'].includes(userRole)

  return isStaff ? <StaffOffers /> : <CandidateOffers />
}

function CandidateOffers() {
  const [myOffers, setMyOffers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [responding, setResponding] = useState(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    offersApi.myOffers()
      .then(data => setMyOffers(Array.isArray(data) ? data : []))
      .catch(e => setError(e?.message || 'Failed to load offers'))
      .finally(() => setLoading(false))
  }, [])

  async function respond(id, response) {
    setResponding(id)
    try {
      await offersApi.respond(id, response)
      setMyOffers(prev => prev.map(o => o.id === id ? { ...o, status: response === 'accepted' ? 'accepted' : 'rejected' } : o))
      setMessage(`Offer ${response}!`)
      setTimeout(() => setMessage(''), 4000)
    } catch (e) {
      setError(e?.message || 'Failed to respond')
    } finally {
      setResponding(null)
    }
  }

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">My Applications</p>
            <h1 className="page-title">My Offers</h1>
            <p className="page-subtitle">Review and respond to job offers sent to you.</p>
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}
        {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center' }}><span className="loading-spinner" /></div>
        ) : myOffers.length === 0 ? (
          <div className="empty-state"><p>No offers yet. Keep an eye on your applications!</p></div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {myOffers.map(offer => (
              <article key={offer.id} className="card">
                <div className="card-header">
                  <div>
                    <div className="card-title">{offer.job_title || `Job #${offer.job_id}`}</div>
                    <div className="card-subtitle">Offered by {offer.offered_by_name || 'HR Team'} · {new Date(offer.created_at).toLocaleDateString()}</div>
                  </div>
                  <StatusBadge status={offer.status} />
                </div>
                {offer.offered_salary && (
                  <p style={{ margin: '0.5rem 0', fontWeight: 600, fontSize: '1.1rem' }}>
                    {offer.salary_currency || 'USD'} {Number(offer.offered_salary).toLocaleString()}
                  </p>
                )}
                {offer.response_deadline && (
                  <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Respond by: {new Date(offer.response_deadline).toLocaleDateString()}
                  </p>
                )}
                {offer.offer_letter_text && (
                  <details style={{ marginTop: '0.5rem' }}>
                    <summary style={{ cursor: 'pointer', fontSize: '0.88rem' }}>View offer letter</summary>
                    <pre style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap', fontSize: '0.82rem', background: 'var(--surface-alt)', padding: '0.75rem', borderRadius: 6 }}>
                      {offer.offer_letter_text}
                    </pre>
                  </details>
                )}
                {offer.status === 'pending' && (
                  <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                    <button
                      type="button" className="btn btn-primary"
                      disabled={responding === offer.id}
                      onClick={() => respond(offer.id, 'accepted')}
                    >Accept Offer</button>
                    <button
                      type="button" className="btn btn-ghost"
                      disabled={responding === offer.id}
                      onClick={() => respond(offer.id, 'rejected')}
                      style={{ color: '#e11d48' }}
                    >Decline</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}

function StaffOffers() {
  const [offerList, setOfferList] = useState([])
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({
    job_id: '', candidate_id: '', offered_salary: '', salary_currency: 'USD',
    response_deadline: '', offer_letter_text: '',
  })

  useEffect(() => {
    Promise.all([offersApi.list(), jobsApi.list(null)])
      .then(([offerData, jobData]) => {
        setOfferList(Array.isArray(offerData) ? offerData : [])
        setJobs(Array.isArray(jobData) ? jobData : [])
      })
      .catch(e => setError(e?.message || 'Failed to load offers'))
      .finally(() => setLoading(false))
  }, [])

  async function createOffer() {
    if (!form.job_id || !form.candidate_id) { setError('Job and Candidate ID are required'); return }
    setCreating(true); setError('')
    try {
      const payload = {
        job_id: Number(form.job_id),
        candidate_id: Number(form.candidate_id),
        offered_salary: form.offered_salary ? Number(form.offered_salary) : null,
        salary_currency: form.salary_currency || 'USD',
        response_deadline: form.response_deadline || null,
        offer_letter_text: form.offer_letter_text || null,
      }
      const created = await offersApi.create(payload)
      setOfferList(prev => [created, ...prev])
      setShowCreate(false)
      setForm({ job_id: '', candidate_id: '', offered_salary: '', salary_currency: 'USD', response_deadline: '', offer_letter_text: '' })
      setMessage('Offer sent to candidate!')
      setTimeout(() => setMessage(''), 4000)
    } catch (e) {
      setError(e?.message || 'Failed to create offer')
    } finally {
      setCreating(false)
    }
  }

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">Recruitment</p>
            <h1 className="page-title">Offers</h1>
            <p className="page-subtitle">Create and manage job offers for candidates.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
            + Create Offer
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}

        {showCreate && (
          <article className="card" style={{ marginBottom: '1.5rem' }}>
            <div className="card-header"><div className="card-title">New Offer</div></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <label className="field-label">Job</label>
                <select className="input" value={form.job_id} onChange={e => setForm(p => ({ ...p, job_id: e.target.value }))}>
                  <option value="">Select job…</option>
                  {jobs.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">Candidate ID</label>
                <input className="input" type="number" placeholder="e.g. 42" value={form.candidate_id} onChange={e => setForm(p => ({ ...p, candidate_id: e.target.value }))} />
              </div>
              <div>
                <label className="field-label">Salary</label>
                <input className="input" type="number" placeholder="e.g. 80000" value={form.offered_salary} onChange={e => setForm(p => ({ ...p, offered_salary: e.target.value }))} />
              </div>
              <div>
                <label className="field-label">Currency</label>
                <select className="input" value={form.salary_currency} onChange={e => setForm(p => ({ ...p, salary_currency: e.target.value }))}>
                  {['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD'].map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">Response Deadline</label>
                <input className="input" type="date" value={form.response_deadline} onChange={e => setForm(p => ({ ...p, response_deadline: e.target.value }))} />
              </div>
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <label className="field-label">Offer Letter (optional)</label>
              <textarea className="input" rows={4} placeholder="Write your offer letter here…" value={form.offer_letter_text} onChange={e => setForm(p => ({ ...p, offer_letter_text: e.target.value }))} />
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
              <button type="button" className="btn btn-primary" disabled={creating} onClick={createOffer}>
                {creating ? 'Sending…' : 'Send Offer'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </article>
        )}

        <article className="card">
          <div className="card-header"><div className="card-title">All Offers</div></div>
          {loading ? (
            <div style={{ padding: '2rem', textAlign: 'center' }}><span className="loading-spinner" /></div>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Job</th>
                    <th>Salary</th>
                    <th>Deadline</th>
                    <th>Status</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {offerList.map(o => (
                    <tr key={o.id}>
                      <td>{o.candidate_name || `#${o.candidate_id}`}</td>
                      <td>{o.job_title || `#${o.job_id}`}</td>
                      <td>{o.offered_salary ? `${o.salary_currency} ${Number(o.offered_salary).toLocaleString()}` : '—'}</td>
                      <td>{o.response_deadline ? new Date(o.response_deadline).toLocaleDateString() : '—'}</td>
                      <td><StatusBadge status={o.status} /></td>
                      <td style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{new Date(o.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                  {offerList.length === 0 && (
                    <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>No offers yet</td></tr>
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
