import { useEffect, useState } from 'react'
import { interviewSlots, jobs as jobsApi, userManagement } from '../api'

function formatDateTime(dt) {
  if (!dt) return '—'
  return new Date(dt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}

export default function InterviewSchedule() {
  const [slots, setSlots] = useState([])
  const [jobs, setJobs] = useState([])
  const [staff, setStaff] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [creating, setCreating] = useState(false)
  const [filterJobId, setFilterJobId] = useState('')
  const [form, setForm] = useState({
    job_id: '', start_time: '', end_time: '', meeting_link: '', notes: '',
  })
  const [scorecardModal, setScorecardModal] = useState(null) // { progress_id, slot }
  const [scorecards, setScorecards] = useState({}) // { progress_id: [...] }
  const [scorecardForm, setScorecardForm] = useState({
    overall_rating: 3, technical_rating: 3, communication_rating: 3, culture_fit_rating: 3,
    recommendation: 'hold', notes: '',
  })
  const [submittingCard, setSubmittingCard] = useState(false)

  const token = localStorage.getItem('token')

  useEffect(() => {
    Promise.all([
      jobsApi.list(token),
      userManagement.listStaff().catch(() => []),
    ]).then(([jobData, staffData]) => {
      setJobs(Array.isArray(jobData) ? jobData : [])
      setStaff(Array.isArray(staffData) ? staffData : [])
    }).catch(() => {})
  }, [])

  useEffect(() => {
    loadSlots()
  }, [filterJobId])

  async function loadSlots() {
    setLoading(true); setError('')
    try {
      const data = await interviewSlots.list(filterJobId ? { job_id: filterJobId } : {})
      setSlots(Array.isArray(data) ? data : [])
    } catch (e) {
      setError(e?.message || 'Failed to load slots')
    } finally {
      setLoading(false)
    }
  }

  async function createSlot() {
    if (!form.job_id || !form.start_time || !form.end_time) {
      setError('Job, start time, and end time are required'); return
    }
    setCreating(true); setError('')
    try {
      const created = await interviewSlots.create({
        job_id: Number(form.job_id),
        start_time: new Date(form.start_time).toISOString(),
        end_time: new Date(form.end_time).toISOString(),
        meeting_link: form.meeting_link || null,
        notes: form.notes || null,
      })
      setSlots(prev => [created, ...prev])
      setShowCreate(false)
      setForm({ job_id: '', start_time: '', end_time: '', meeting_link: '', notes: '' })
      setMessage('Interview slot created!')
      setTimeout(() => setMessage(''), 3000)
    } catch (e) {
      setError(e?.message || 'Failed to create slot')
    } finally {
      setCreating(false)
    }
  }

  async function removeSlot(id) {
    if (!window.confirm('Delete this slot?')) return
    try {
      await interviewSlots.remove(id)
      setSlots(prev => prev.filter(s => s.id !== id))
    } catch (e) {
      setError(e?.message || 'Failed to delete slot')
    }
  }

  async function openScorecard(slot) {
    const pid = slot.progress_id
    if (!pid) { setError('No candidate booked this slot yet'); return }
    setScorecardModal({ progress_id: pid, slot })
    if (!scorecards[pid]) {
      try {
        const data = await interviewSlots.getScorecard(pid)
        setScorecards(prev => ({ ...prev, [pid]: Array.isArray(data?.scorecards) ? data.scorecards : [] }))
      } catch { setScorecards(prev => ({ ...prev, [pid]: [] })) }
    }
  }

  async function submitScorecard() {
    if (!scorecardModal) return
    setSubmittingCard(true)
    try {
      await interviewSlots.submitScorecard(scorecardModal.progress_id, scorecardForm)
      setMessage('Scorecard submitted!')
      setScorecardModal(null)
      setTimeout(() => setMessage(''), 3000)
    } catch (e) {
      setError(e?.message || 'Failed to submit scorecard')
    } finally {
      setSubmittingCard(false)
    }
  }

  const jobMap = Object.fromEntries(jobs.map(j => [j.id, j.title]))

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">Recruitment</p>
            <h1 className="page-title">Interview Schedule</h1>
            <p className="page-subtitle">Manage interview slots, assign interviewers, and record scorecards.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>+ New Slot</button>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {message && <div className="alert alert-success">{message}</div>}

        {/* Filters */}
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem', alignItems: 'center' }}>
          <select className="input" value={filterJobId} onChange={e => setFilterJobId(e.target.value)} style={{ width: 220 }}>
            <option value="">All jobs</option>
            {jobs.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}
          </select>
        </div>

        {/* Create form */}
        {showCreate && (
          <article className="card" style={{ marginBottom: '1.5rem' }}>
            <div className="card-header"><div className="card-title">New Interview Slot</div></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <label className="field-label">Job *</label>
                <select className="input" value={form.job_id} onChange={e => setForm(p => ({ ...p, job_id: e.target.value }))}>
                  <option value="">Select job…</option>
                  {jobs.map(j => <option key={j.id} value={j.id}>{j.title}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">Meeting Link</label>
                <input className="input" type="url" placeholder="https://meet.google.com/…" value={form.meeting_link} onChange={e => setForm(p => ({ ...p, meeting_link: e.target.value }))} />
              </div>
              <div>
                <label className="field-label">Start Time *</label>
                <input className="input" type="datetime-local" value={form.start_time} onChange={e => setForm(p => ({ ...p, start_time: e.target.value }))} />
              </div>
              <div>
                <label className="field-label">End Time *</label>
                <input className="input" type="datetime-local" value={form.end_time} onChange={e => setForm(p => ({ ...p, end_time: e.target.value }))} />
              </div>
              <div style={{ gridColumn: '1/-1' }}>
                <label className="field-label">Notes</label>
                <textarea className="input" rows={2} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
              <button type="button" className="btn btn-primary" disabled={creating} onClick={createSlot}>{creating ? 'Creating…' : 'Create Slot'}</button>
              <button type="button" className="btn btn-ghost" onClick={() => setShowCreate(false)}>Cancel</button>
            </div>
          </article>
        )}

        {/* Slots table */}
        <article className="card">
          <div className="card-header"><div className="card-title">Interview Slots</div></div>
          {loading ? (
            <div style={{ padding: '2rem', textAlign: 'center' }}><span className="loading-spinner" /></div>
          ) : (
            <div className="table-wrapper">
              <table className="table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Status</th>
                    <th>Candidate</th>
                    <th>Meeting</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map(s => (
                    <tr key={s.id}>
                      <td>{jobMap[s.job_id] || `#${s.job_id}`}</td>
                      <td style={{ fontSize: '0.85rem' }}>{formatDateTime(s.start_time)}</td>
                      <td style={{ fontSize: '0.85rem' }}>{formatDateTime(s.end_time)}</td>
                      <td>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 999,
                          fontSize: '0.78rem', fontWeight: 600,
                          background: s.is_booked ? '#05966922' : '#0e749022',
                          color: s.is_booked ? '#059669' : '#0e7490',
                        }}>{s.is_booked ? 'Booked' : 'Available'}</span>
                      </td>
                      <td>{s.candidate_name || (s.progress_id ? `Progress #${s.progress_id}` : '—')}</td>
                      <td>
                        {s.meeting_link ? (
                          <a href={s.meeting_link} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">Join</a>
                        ) : '—'}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.4rem' }}>
                          {s.is_booked && s.progress_id && (
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => openScorecard(s)}>Scorecard</button>
                          )}
                          <button type="button" className="btn btn-ghost btn-sm" style={{ color: '#e11d48' }} onClick={() => removeSlot(s.id)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {slots.length === 0 && (
                    <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>No slots found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </article>

        {/* Scorecard Modal */}
        {scorecardModal && (
          <div className="modal-overlay" onClick={() => setScorecardModal(null)}>
            <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 540 }}>
              <div className="modal-header">
                <h3>Interview Scorecard</h3>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setScorecardModal(null)}>✕</button>
              </div>
              <div style={{ padding: '1rem' }}>
                {/* Past scorecards */}
                {scorecards[scorecardModal.progress_id]?.length > 0 && (
                  <div style={{ marginBottom: '1.5rem' }}>
                    <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Previous Scorecards</div>
                    {scorecards[scorecardModal.progress_id].map((sc, i) => (
                      <div key={i} style={{ background: 'var(--surface-alt)', borderRadius: 6, padding: '0.75rem', marginBottom: '0.5rem', fontSize: '0.85rem' }}>
                        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                          <span>Overall: <strong>{sc.overall_rating}/5</strong></span>
                          <span>Technical: <strong>{sc.technical_rating}/5</strong></span>
                          <span>Communication: <strong>{sc.communication_rating}/5</strong></span>
                          <span>Culture: <strong>{sc.culture_fit_rating}/5</strong></span>
                          <span style={{ color: sc.recommendation === 'hire' ? '#059669' : sc.recommendation === 'reject' ? '#e11d48' : '#b45309' }}>
                            {sc.recommendation?.toUpperCase()}
                          </span>
                        </div>
                        {sc.notes && <p style={{ marginTop: '0.4rem', color: 'var(--text-secondary)' }}>{sc.notes}</p>}
                      </div>
                    ))}
                  </div>
                )}

                {/* New scorecard form */}
                <div style={{ fontWeight: 600, marginBottom: '0.75rem' }}>Submit New Scorecard</div>
                {['overall_rating', 'technical_rating', 'communication_rating', 'culture_fit_rating'].map(field => (
                  <div key={field} style={{ marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <label style={{ width: 170, fontSize: '0.88rem' }}>{field.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</label>
                    <input
                      type="range" min={1} max={5} step={1}
                      value={scorecardForm[field]}
                      onChange={e => setScorecardForm(p => ({ ...p, [field]: Number(e.target.value) }))}
                      style={{ flex: 1 }}
                    />
                    <span style={{ width: 20, textAlign: 'right' }}>{scorecardForm[field]}</span>
                  </div>
                ))}
                <div style={{ marginBottom: '0.75rem', marginTop: '0.5rem' }}>
                  <label className="field-label">Recommendation</label>
                  <select className="input" value={scorecardForm.recommendation} onChange={e => setScorecardForm(p => ({ ...p, recommendation: e.target.value }))}>
                    <option value="hire">Hire</option>
                    <option value="hold">Hold</option>
                    <option value="reject">Reject</option>
                  </select>
                </div>
                <div style={{ marginBottom: '0.75rem' }}>
                  <label className="field-label">Notes</label>
                  <textarea className="input" rows={3} value={scorecardForm.notes} onChange={e => setScorecardForm(p => ({ ...p, notes: e.target.value }))} />
                </div>
              </div>
              <div className="modal-footer" style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost" onClick={() => setScorecardModal(null)}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={submittingCard} onClick={submitScorecard}>
                  {submittingCard ? 'Submitting…' : 'Submit Scorecard'}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}
