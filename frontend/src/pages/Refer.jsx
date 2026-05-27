import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { referrals } from '../api'

export default function Refer() {
  const [jobs, setJobs] = useState([])
  const [form, setForm] = useState({
    job_id: '',
    referrer_name: '',
    referrer_email: '',
    referrer_employee_id: '',
    candidate_name: '',
    candidate_email: '',
    candidate_phone: '',
    relationship: '',
    note: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    referrals.activeJobs().then(data => {
      setJobs(Array.isArray(data) ? data : [])
    }).catch(() => setJobs([]))
  }, [])

  function set(field) {
    return (e) => setForm(p => ({ ...p, [field]: e.target.value }))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!form.job_id) { setError('Please select a role.'); return }
    if (!form.referrer_name.trim() || !form.referrer_email.trim()) {
      setError('Your name and email are required.')
      return
    }
    if (!form.candidate_name.trim() || !form.candidate_email.trim()) {
      setError("Candidate's name and email are required.")
      return
    }
    setSubmitting(true)
    try {
      await referrals.submit({
        ...form,
        job_id: Number(form.job_id),
        referrer_employee_id: form.referrer_employee_id.trim() || null,
        candidate_phone: form.candidate_phone.trim() || null,
        relationship: form.relationship.trim() || null,
        note: form.note.trim() || null,
      })
      setSuccess(true)
    } catch (err) {
      setError(err?.message || 'Failed to submit referral. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (success) {
    return (
      <main className="main">
        <section className="dashboard-page" style={{ maxWidth: 520, margin: '0 auto', textAlign: 'center', paddingTop: '4rem' }}>
          <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'var(--green-soft, rgba(34,197,94,0.1))', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.25rem' }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.5rem' }}>Referral Submitted!</h1>
          <p className="muted" style={{ lineHeight: 1.6, marginBottom: '2rem' }}>
            Thank you for your referral. Our recruiting team will review it and reach out to the candidate if they're a good fit.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center' }}>
            <button type="button" className="btn btn-ghost" onClick={() => { setSuccess(false); setForm({ job_id: '', referrer_name: '', referrer_email: '', referrer_employee_id: '', candidate_name: '', candidate_email: '', candidate_phone: '', relationship: '', note: '' }) }}>
              Submit Another
            </button>
            <Link to="/"><button type="button" className="btn btn-primary">Go Home</button></Link>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="main">
      <section className="dashboard-page" style={{ maxWidth: 600, margin: '0 auto' }}>
        <div className="page-header-row">
          <div>
            <p className="eyebrow">Employee Referral</p>
            <h1 className="page-title">Refer a Candidate</h1>
            <p className="page-subtitle">Know someone great? Refer them to an open role.</p>
          </div>
        </div>

        <article className="card" style={{ padding: '1.75rem' }}>
          {error && <div className="error-banner" style={{ marginBottom: '1rem' }}>{error}</div>}

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            {/* Role */}
            <div>
              <label className="label" htmlFor="ref-job">Role you're referring for <span style={{ color: 'var(--error)' }}>*</span></label>
              <select id="ref-job" className="input" value={form.job_id} onChange={set('job_id')} required>
                <option value="">Select a role…</option>
                {jobs.map(j => (
                  <option key={j.id} value={j.id}>{j.title}{j.location ? ` — ${j.location}` : ''}</option>
                ))}
              </select>
            </div>

            {/* Referrer info */}
            <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '1rem 1.25rem' }}>
              <legend style={{ fontWeight: 600, fontSize: '0.85rem', padding: '0 0.4rem' }}>Your Information</legend>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label className="label" htmlFor="ref-rname">Your name <span style={{ color: 'var(--error)' }}>*</span></label>
                  <input id="ref-rname" className="input" value={form.referrer_name} onChange={set('referrer_name')} placeholder="Jane Smith" required />
                </div>
                <div>
                  <label className="label" htmlFor="ref-remail">Your email <span style={{ color: 'var(--error)' }}>*</span></label>
                  <input id="ref-remail" className="input" type="email" value={form.referrer_email} onChange={set('referrer_email')} placeholder="jane@company.com" required />
                </div>
              </div>
              <div style={{ marginTop: '0.75rem' }}>
                <label className="label" htmlFor="ref-empid">Employee ID <span className="muted">(optional)</span></label>
                <input id="ref-empid" className="input" value={form.referrer_employee_id} onChange={set('referrer_employee_id')} placeholder="EMP-12345" />
              </div>
            </fieldset>

            {/* Candidate info */}
            <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '1rem 1.25rem' }}>
              <legend style={{ fontWeight: 600, fontSize: '0.85rem', padding: '0 0.4rem' }}>Candidate Information</legend>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label className="label" htmlFor="ref-cname">Candidate name <span style={{ color: 'var(--error)' }}>*</span></label>
                  <input id="ref-cname" className="input" value={form.candidate_name} onChange={set('candidate_name')} placeholder="John Doe" required />
                </div>
                <div>
                  <label className="label" htmlFor="ref-cemail">Candidate email <span style={{ color: 'var(--error)' }}>*</span></label>
                  <input id="ref-cemail" className="input" type="email" value={form.candidate_email} onChange={set('candidate_email')} placeholder="john@email.com" required />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginTop: '0.75rem' }}>
                <div>
                  <label className="label" htmlFor="ref-cphone">Phone <span className="muted">(optional)</span></label>
                  <input id="ref-cphone" className="input" type="tel" value={form.candidate_phone} onChange={set('candidate_phone')} placeholder="+91 98765 43210" />
                </div>
                <div>
                  <label className="label" htmlFor="ref-rel">Your relationship <span className="muted">(optional)</span></label>
                  <input id="ref-rel" className="input" value={form.relationship} onChange={set('relationship')} placeholder="Ex-colleague, Friend…" />
                </div>
              </div>
            </fieldset>

            {/* Note */}
            <div>
              <label className="label" htmlFor="ref-note">Why are you recommending this person? <span className="muted">(optional)</span></label>
              <textarea id="ref-note" className="input" rows={3} value={form.note} onChange={set('note')} placeholder="Share what makes this candidate stand out…" />
            </div>

            <button type="submit" className="btn btn-primary" disabled={submitting} style={{ alignSelf: 'flex-end', minWidth: 160 }}>
              {submitting
                ? <><span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />&nbsp;Submitting…</>
                : 'Submit Referral'}
            </button>
          </form>
        </article>
      </section>
    </main>
  )
}
