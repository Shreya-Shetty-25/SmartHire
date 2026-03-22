import { useCallback, useEffect, useRef, useState } from 'react'
import { assessmentApi } from '../assessmentApi'

/* ─── helpers ─── */
function fmt(totalSeconds) {
  const s = Math.max(0, Number(totalSeconds || 0))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const EL = {
  suspicious_eye_movement: 'Eye movement away from screen',
  suspicious_head_movement: 'Head movement detected',
  suspicious_object_detected: 'Suspicious object detected',
  audio_anomaly_detected: 'Background noise detected',
  voice_activity_detected: 'Voice activity detected',
  speech_detected: 'Speech detected',
  multiple_faces_detected: 'Multiple faces detected',
  no_face_detected: 'Face not visible',
  suspicious_candidate_identity_change: 'Identity mismatch',
  tab_switch_detected: 'Tab switch detected',
  window_blur: 'Window lost focus',
  page_hidden: 'Page hidden',
  focus_lost: 'Focus lost',
  fullscreen_exited: 'Fullscreen exited',
  fullscreen_required_not_entered: 'Fullscreen was not entered',
  camera_stream_ended: 'Camera stream ended',
  mic_stream_ended: 'Microphone stream ended',
  camera_track_muted: 'Camera muted',
  mic_track_muted: 'Microphone muted',
  camera_permission_revoked: 'Camera permission revoked',
  mic_permission_revoked: 'Microphone permission revoked',
  camera_device_changed: 'Camera device changed',
  mic_device_changed: 'Microphone device changed',
  camera_no_video_signal: 'Camera signal lost',
  camera_video_frozen: 'Camera video frozen',
  devtools_suspected: 'Developer tools suspected',
  copy_blocked: 'Copy blocked',
  cut_blocked: 'Cut blocked',
  paste_blocked: 'Paste blocked',
  context_menu_blocked: 'Context menu blocked',
  clipboard_shortcut_blocked: 'Clipboard shortcut blocked',
  devtools_shortcut_blocked: 'DevTools shortcut blocked',
  print_shortcut_blocked: 'Print shortcut blocked',
  save_shortcut_blocked: 'Save shortcut blocked',
  screenshot_blocked: 'Screenshot blocked',
  screen_capture_blocked: 'Screen capture blocked',
  print_screen_blocked: 'Print Screen blocked',
  drag_blocked: 'Drag blocked',
  select_all_blocked: 'Select-all blocked',
}
function label(t) { return EL[t] || String(t || '').replaceAll('_', ' ') }

/* ─── tiny SVG icons ─── */
function IcoCheck({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none"><path d="M5 10.5L8.5 14L15 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
function IcoShield({ size = 28 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M12 2L4 6v5c0 5.25 3.4 10.15 8 11.4 4.6-1.25 8-6.15 8-11.4V6l-8-4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/><path d="M8.5 12.5l2.2 2.2 4.8-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
}
function IcoTimer({ size = 16 }) {
  return <svg width={size} height={size} viewBox="0 0 20 20" fill="none"><circle cx="10" cy="11" r="7" stroke="currentColor" strokeWidth="1.5"/><path d="M10 8v3l2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M8 2h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
}
function IcoCamera({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><circle cx="12" cy="13" r="4" stroke="currentColor" strokeWidth="1.5"/></svg>
}
function IcoMic({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><rect x="9" y="1" width="6" height="12" rx="3" stroke="currentColor" strokeWidth="1.5"/><path d="M5 10a7 7 0 0014 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M12 19v4M8 23h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
}
function IcoSpeaker({ size = 18 }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H2v6h4l5 4V5z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/><path d="M15.54 8.46a5 5 0 010 7.07M19.07 4.93a10 10 0 010 14.14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
}

/* ═══════════════════════════════════════════════════════ */
/*                  ASSESSMENT COMPONENT                  */
/* ═══════════════════════════════════════════════════════ */
function Assessment() {
  /* ── state ── */
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [violationCounts, setViolationCounts] = useState({})
  const [toast, setToast] = useState('')
  const toastTimeoutRef = useRef(null)

  const [sessionCodeInput, setSessionCodeInput] = useState('')
  const [sessionCode, setSessionCode] = useState('')

  const [cameraOk, setCameraOk] = useState(false)
  const [micOk, setMicOk] = useState(false)
  const [speakerOk, setSpeakerOk] = useState(false)
  const [speakerTestPlayed, setSpeakerTestPlayed] = useState(false)
  const [micLevel, setMicLevel] = useState(0)

  const [starting, setStarting] = useState(false)
  const [exam, setExam] = useState(null)
  const [answers, setAnswers] = useState({})
  const [running, setRunning] = useState(false)
  const [timeLeft, setTimeLeft] = useState(0)
  const [result, setResult] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [terminationReason, setTerminationReason] = useState('')
  const [tabSwitchCount, setTabSwitchCount] = useState(0)
  const [antiCheatFlags, setAntiCheatFlags] = useState([])

  const [currentQ, setCurrentQ] = useState(0)
  const [showConfirmSubmit, setShowConfirmSubmit] = useState(false)

  const videoRef = useRef(null)
  const frameCanvasRef = useRef(null)
  const cameraStreamRef = useRef(null)
  const micStreamRef = useRef(null)
  const micCtxRef = useRef(null)
  const micIntervalRef = useRef(null)
  const submissionStateRef = useRef({ inFlight: false })

  const vadStateRef = useRef({ speaking: false, aboveMs: 0, lastEventAt: 0, lastSpeechAt: 0 })
  const speechRecRef = useRef(null)
  const speechBufferRef = useRef({ lastText: '', lastSentAt: 0 })

  const tabSwitchCountRef = useRef(0)
  const proctorIntervalIdsRef = useRef([])
  const proctorListenersRef = useRef([])

  const fullscreenStateRef = useRef({ shouldEnforce: false, enteredOnce: false, startAt: 0 })
  const violationStateRef = useRef({})
  const nonBlockingEventRef = useRef({})
  const streamGuardRef = useRef({ cameraDeviceId: null, micDeviceId: null, lastVideoTime: 0, frozenStreak: 0 })

  const hasCode = Boolean(String(sessionCodeInput || '').trim())
  const precheckPassed = cameraOk && micOk && speakerOk
  const questions = exam?.questions || []
  const totalQ = questions.length
  const answeredCount = Object.keys(answers).filter((k) => answers[k]).length

  /* ── shared helpers ── */
  const showToast = useCallback((message) => {
    const m = String(message || '').trim(); if (!m) return
    setToast(m)
    if (toastTimeoutRef.current) clearTimeout(toastTimeoutRef.current)
    toastTimeoutRef.current = setTimeout(() => { setToast(''); toastTimeoutRef.current = null }, 3500)
  }, [])

  const pushFlag = useCallback((text) => {
    const t = String(text || '').trim(); if (!t) return
    setAntiCheatFlags((p) => [t, ...(p || [])].slice(0, 12))
  }, [])

  const finalizeUi = useCallback((msg = '', reason = '') => {
    setRunning(false); setTerminationReason(reason); if (msg) setInfo(msg)
    stopProctoring(); stopPrechecks()
  }, [])

  /* ── submit ── */
  const handleSubmit = useCallback(
    async (auto = false, customMessage = '') => {
      if (!sessionCode || !exam || result || submissionStateRef.current.inFlight) return
      submissionStateRef.current.inFlight = true
      setSubmitting(true); setError(''); setShowConfirmSubmit(false)
      const payload = questions.map((q) => ({ question_id: q.id, answer: answers[q.id] || '' }))

      if (auto) {
        setResult({ auto_submitted: true, status: 'submitted' })
        finalizeUi(customMessage || 'Test submitted. Results will be shared soon.', customMessage)
      }
      try {
        const sub = await assessmentApi.submitExam(sessionCode, payload)
        void assessmentApi.logEvent({ session_code: sessionCode, event_type: 'exam_submitted', severity: 'low', payload: { auto, tab_switch_count: tabSwitchCountRef.current } }).catch(() => {})
        setResult(sub)
        if (!auto) finalizeUi(customMessage || 'Test submitted successfully.', customMessage)
      } catch (err) {
        if (auto) { setResult({ auto_submitted: true, status: 'submitted' }); setError('Auto-submit completed locally but server sync failed.') }
        else setError(err?.message || 'Submit failed')
      } finally { submissionStateRef.current.inFlight = false; setSubmitting(false) }
    },
    [answers, exam, finalizeUi, questions, result, sessionCode],
  )

  /* ── violations ── */
  const recordViolation = useCallback(
    async (eventType, { severity = 'medium', payload = null, maxWarnings = 3, cooldownMs = 6000, immediateClose = false } = {}) => {
      if (!running || result) return
      const type = String(eventType || 'violation')
      const now = Date.now()
      const prev = violationStateRef.current[type] || { count: 0, lastAt: 0 }
      if (cooldownMs && now - (prev.lastAt || 0) < cooldownMs) return
      const nextCount = (prev.count || 0) + 1
      violationStateRef.current[type] = { count: nextCount, lastAt: now }
      setViolationCounts((c) => ({ ...(c || {}), [type]: { count: nextCount, maxWarnings: Number(maxWarnings || 0) } }))
      pushFlag(maxWarnings > 0 ? `${label(type)} (${nextCount}/${maxWarnings})` : label(type))
      try { await assessmentApi.logEvent({ session_code: sessionCode, event_type: type, severity, payload: { count: nextCount, ...(payload || {}) } }) } catch { /* */ }
      if (immediateClose) { void handleSubmit(true, 'Test submitted. Results will be shared soon.'); return }
      if (maxWarnings > 0) {
        if (nextCount < maxWarnings) { showToast(`Warning: ${label(type)} (${nextCount}/${maxWarnings})`); return }
        if (nextCount === maxWarnings) { showToast(`Final warning: ${label(type)} — auto-submitting`); void handleSubmit(true, 'Test submitted. Results will be shared soon.'); return }
      }
      void handleSubmit(true, 'Test submitted. Results will be shared soon.')
    },
    [handleSubmit, pushFlag, result, running, sessionCode, showToast],
  )

  const logNonBlocking = useCallback(
    async (eventType, { severity = 'medium', payload = null, cooldownMs = 12000, maxAlerts = 2 } = {}) => {
      if (!running || result) return
      const type = String(eventType || 'event')
      const now = Date.now()
      const prev = nonBlockingEventRef.current[type] || { lastAt: 0, count: 0 }
      if (cooldownMs && now - (prev.lastAt || 0) < cooldownMs) return
      const nc = (prev.count || 0) + 1
      nonBlockingEventRef.current[type] = { lastAt: now, count: nc }
      pushFlag(label(type))
      try { await assessmentApi.logEvent({ session_code: sessionCode, event_type: type, severity, payload: { count: nc, ...(payload || {}) } }) } catch { /* */ }
      if (nc <= maxAlerts) showToast(`Notice: ${label(type)}`)
    },
    [pushFlag, result, running, sessionCode, showToast],
  )

  const closeNow = useCallback(
    (eventType, payload = null) => {
      if (!running || result) return
      showToast(`Violation: ${label(eventType)} — auto-submitting`)
      void recordViolation(eventType, { severity: 'high', payload, immediateClose: true, maxWarnings: 0, cooldownMs: 0 })
    },
    [recordViolation, result, running, showToast],
  )

  const tabClose = useCallback(
    (eventType, payload = null) => {
      if (!running || result) return
      tabSwitchCountRef.current += 1
      setTabSwitchCount(tabSwitchCountRef.current)
      closeNow(eventType, { tab_switch_count: tabSwitchCountRef.current, ...(payload || {}) })
    },
    [closeNow, result, running],
  )

  /* ── init ── */
  useEffect(() => {
    const qc = new URLSearchParams(window.location.search).get('code')
    if (qc) setSessionCodeInput(String(qc).trim().toUpperCase())
    startPrechecks()
    return () => { stopProctoring(); stopPrechecks(); if (toastTimeoutRef.current) { clearTimeout(toastTimeoutRef.current); toastTimeoutRef.current = null } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── timer ── */
  useEffect(() => {
    if (!running || timeLeft <= 0) return
    const id = setInterval(() => {
      setTimeLeft((v) => { if (v <= 1) { clearInterval(id); handleSubmit(true, 'Time ended. Auto-submitted.'); return 0 } return v - 1 })
    }, 1000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, timeLeft])

  /* ── beforeunload + history lock ── */
  useEffect(() => {
    if (!running || result) return
    const onBU = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', onBU)
    window.history.pushState(null, '', window.location.href)
    const onPop = () => { window.history.pushState(null, '', window.location.href) }
    window.addEventListener('popstate', onPop)
    return () => { window.removeEventListener('beforeunload', onBU); window.removeEventListener('popstate', onPop) }
  }, [running, result])

  /* ── tab / visibility / fullscreen ── */
  useEffect(() => {
    if (!running || result) return
    const getFs = () => document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement
    const isFs = () => Boolean(getFs())
    const tryFs = () => { try { const el = document.documentElement; const r = el.requestFullscreen || el.webkitRequestFullscreen; if (!isFs() && r) void r.call(el) } catch { /* */ } }

    const onVis = () => { if (document.hidden) tabClose('tab_switch_detected', { source: 'visibilitychange' }); else tryFs() }
    const onBlur = () => { tabClose('window_blur', { source: 'blur' }) }
    const onPageHide = () => { tabClose('page_hidden', { source: 'pagehide' }) }
    const onFocusOut = () => { if (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())) tabClose('focus_lost', { source: 'focusout' }) }
    const onFsChange = () => { if (!isFs()) tabClose('fullscreen_exited', { source: 'fullscreenchange' }) }

    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('focusout', onFocusOut)
    document.addEventListener('fullscreenchange', onFsChange)
    document.addEventListener('webkitfullscreenchange', onFsChange)

    const guardId = setInterval(() => {
      try {
        if (!running || result) return
        const fs = fullscreenStateRef.current
        if (fs.shouldEnforce) {
          const inFs = isFs(); if (inFs) fs.enteredOnce = true
          if (!fs.enteredOnce && fs.startAt && Date.now() - fs.startAt > 2500) { tabClose('fullscreen_required_not_entered', { source: 'guard' }); return }
          if (fs.enteredOnce && !inFs) { tabClose('fullscreen_exited', { source: 'guard' }); return }
        }
        if (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())) tabClose('focus_lost', { source: 'guard' })
      } catch { /* */ }
    }, 120)

    proctorListenersRef.current.push(
      { target: document, event: 'visibilitychange', handler: onVis },
      { target: window, event: 'blur', handler: onBlur },
      { target: window, event: 'pagehide', handler: onPageHide },
      { target: window, event: 'focusout', handler: onFocusOut },
      { target: document, event: 'fullscreenchange', handler: onFsChange },
      { target: document, event: 'webkitfullscreenchange', handler: onFsChange },
    )
    proctorIntervalIdsRef.current.push(guardId)
    return () => {
      document.removeEventListener('visibilitychange', onVis); window.removeEventListener('blur', onBlur)
      window.removeEventListener('pagehide', onPageHide); window.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('fullscreenchange', onFsChange); document.removeEventListener('webkitfullscreenchange', onFsChange)
      clearInterval(guardId)
    }
  }, [tabClose, result, running])

  /* ── device / stream tamper ── */
  useEffect(() => {
    if (!running || result) return
    const g = streamGuardRef.current; g.frozenStreak = 0; g.lastVideoTime = 0
    const video = videoRef.current
    const cs = cameraStreamRef.current; const ms = micStreamRef.current
    const ct = cs?.getVideoTracks?.()?.[0]; const mt = ms?.getAudioTracks?.()?.[0]
    try { g.cameraDeviceId = ct?.getSettings?.().deviceId || null; g.micDeviceId = mt?.getSettings?.().deviceId || null } catch { /* */ }

    const onCE = () => closeNow('camera_stream_ended'); const onME = () => closeNow('mic_stream_ended')
    const onCM = () => closeNow('camera_track_muted'); const onMM = () => closeNow('mic_track_muted')
    if (ct) { ct.addEventListener?.('ended', onCE); ct.addEventListener?.('mute', onCM) }
    if (mt) { mt.addEventListener?.('ended', onME); mt.addEventListener?.('mute', onMM) }

    const gid = setInterval(async () => {
      try {
        if (!running || result) return
        if (navigator.permissions?.query) {
          try { const p = await navigator.permissions.query({ name: 'camera' }); if (p?.state === 'denied') { closeNow('camera_permission_revoked'); return } } catch { /* */ }
          try { const p = await navigator.permissions.query({ name: 'microphone' }); if (p?.state === 'denied') { closeNow('mic_permission_revoked'); return } } catch { /* */ }
        }
        try { const id = ct?.getSettings?.().deviceId || null; if (g.cameraDeviceId && id && id !== g.cameraDeviceId) { closeNow('camera_device_changed'); return } } catch { /* */ }
        try { const id = mt?.getSettings?.().deviceId || null; if (g.micDeviceId && id && id !== g.micDeviceId) { closeNow('mic_device_changed'); return } } catch { /* */ }
        if (video && ct?.readyState === 'live') {
          if (!video.videoWidth || !video.videoHeight) { closeNow('camera_no_video_signal'); return }
          const t = Number(video.currentTime || 0)
          if (g.lastVideoTime && t <= g.lastVideoTime + 0.01) g.frozenStreak += 1; else g.frozenStreak = 0
          g.lastVideoTime = t
          if (g.frozenStreak >= 6) closeNow('camera_video_frozen', { frozen_streak: g.frozenStreak })
        }
      } catch { /* */ }
    }, 1000)
    proctorIntervalIdsRef.current.push(gid)
    return () => {
      clearInterval(gid)
      try { ct?.removeEventListener?.('ended', onCE); ct?.removeEventListener?.('mute', onCM); mt?.removeEventListener?.('ended', onME); mt?.removeEventListener?.('mute', onMM) } catch { /* */ }
    }
  }, [closeNow, result, running])

  /* ── devtools detection ── */
  useEffect(() => {
    if (!running || result) return
    const id = setInterval(() => {
      try {
        if (!running || result) return
        const dW = Math.abs((window.outerWidth || 0) - (window.innerWidth || 0))
        const dH = Math.abs((window.outerHeight || 0) - (window.innerHeight || 0))
        if (dW > 180 || dH > 180) void logNonBlocking('devtools_suspected', { severity: 'medium', payload: { dW, dH }, cooldownMs: 15000, maxAlerts: 2 })
      } catch { /* */ }
    }, 1500)
    proctorIntervalIdsRef.current.push(id)
    return () => clearInterval(id)
  }, [logNonBlocking, result, running])

  /* ── keyboard / clipboard / drag / screenshot blocking ── */
  useEffect(() => {
    if (!running || result) return
    const logB = (ev, pl) => { pushFlag(`Blocked: ${label(ev)}`); try { void assessmentApi.logEvent({ session_code: sessionCode, event_type: ev, severity: 'medium', payload: pl || null }) } catch { /* */ } }

    const onCopy = (e) => { e.preventDefault(); logB('copy_blocked') }
    const onCut = (e) => { e.preventDefault(); logB('cut_blocked') }
    const onPaste = (e) => { e.preventDefault(); logB('paste_blocked') }
    const onCtx = (e) => { e.preventDefault(); logB('context_menu_blocked') }
    const onKey = (e) => {
      const k = String(e.key || '').toLowerCase()
      const c = e.ctrlKey || e.metaKey; const a = e.altKey; const s = e.shiftKey
      if (c && ['c', 'v', 'x'].includes(k)) { e.preventDefault(); logB('clipboard_shortcut_blocked', { key: e.key }); return }
      if (k === 'f12' || (c && s && k === 'i') || (c && s && k === 'j') || (c && k === 'u')) { e.preventDefault(); logB('devtools_shortcut_blocked', { key: e.key }); return }
      if (c && k === 'p') { e.preventDefault(); logB('print_shortcut_blocked'); return }
      if (c && k === 's') { e.preventDefault(); logB('save_shortcut_blocked') }
      if (k === 'printscreen' || k === 'snapshot') { e.preventDefault(); logB('print_screen_blocked') }
      if (e.metaKey && s && k === 's') { e.preventDefault(); logB('screenshot_blocked', { combo: 'Win+Shift+S' }) }
      if (c && k === 'a') { e.preventDefault(); logB('select_all_blocked') }
      if (a && k === 'tab') { e.preventDefault(); logB('tab_switch_detected', { combo: 'Alt+Tab' }) }
    }
    const onDrag = (e) => { e.preventDefault(); logB('drag_blocked') }
    const onDrop = (e) => { e.preventDefault() }
    const onSelect = (e) => { e.preventDefault() }

    document.addEventListener('copy', onCopy); document.addEventListener('cut', onCut)
    document.addEventListener('paste', onPaste); document.addEventListener('contextmenu', onCtx)
    window.addEventListener('keydown', onKey); document.addEventListener('dragstart', onDrag)
    document.addEventListener('drop', onDrop); document.addEventListener('selectstart', onSelect)

    if (navigator.mediaDevices?.getDisplayMedia) {
      const orig = navigator.mediaDevices.getDisplayMedia
      navigator.mediaDevices.getDisplayMedia = function () { logB('screen_capture_blocked'); return Promise.reject(new Error('Screen capture blocked')) }
      window.__origGDM = orig
    }
    document.body.style.userSelect = 'none'; document.body.style.webkitUserSelect = 'none'

    proctorListenersRef.current.push(
      { target: document, event: 'copy', handler: onCopy }, { target: document, event: 'cut', handler: onCut },
      { target: document, event: 'paste', handler: onPaste }, { target: document, event: 'contextmenu', handler: onCtx },
      { target: window, event: 'keydown', handler: onKey }, { target: document, event: 'dragstart', handler: onDrag },
      { target: document, event: 'drop', handler: onDrop }, { target: document, event: 'selectstart', handler: onSelect },
    )
    return () => {
      document.removeEventListener('copy', onCopy); document.removeEventListener('cut', onCut)
      document.removeEventListener('paste', onPaste); document.removeEventListener('contextmenu', onCtx)
      window.removeEventListener('keydown', onKey); document.removeEventListener('dragstart', onDrag)
      document.removeEventListener('drop', onDrop); document.removeEventListener('selectstart', onSelect)
      document.body.style.userSelect = ''; document.body.style.webkitUserSelect = ''
      if (window.__origGDM && navigator.mediaDevices) { navigator.mediaDevices.getDisplayMedia = window.__origGDM; delete window.__origGDM }
    }
  }, [pushFlag, result, running, sessionCode])

  /* keep camera bound */
  useEffect(() => {
    if (!running || result) return
    if (cameraStreamRef.current && videoRef.current) { videoRef.current.srcObject = cameraStreamRef.current; videoRef.current.play().catch(() => {}) }
  }, [running, result])

  /* ── proctoring helpers ── */
  function stopProctoring() {
    proctorIntervalIdsRef.current.forEach((id) => clearInterval(id)); proctorIntervalIdsRef.current = []
    proctorListenersRef.current.forEach(({ target, event, handler }) => target.removeEventListener(event, handler)); proctorListenersRef.current = []
    try { if (speechRecRef.current) { speechRecRef.current.onresult = null; speechRecRef.current.onerror = null; speechRecRef.current.onend = null; speechRecRef.current.stop() } } catch { /* */ }
    speechRecRef.current = null
  }

  async function sendCameraFrame(session) {
    const v = videoRef.current; const c = frameCanvasRef.current
    if (!v || !c || !session || !v.videoWidth || !v.videoHeight) return
    const ctx = c.getContext('2d'); c.width = v.videoWidth; c.height = v.videoHeight; ctx.drawImage(v, 0, 0, c.width, c.height)
    const img = c.toDataURL('image/jpeg', 0.7)
    try {
      const r = await assessmentApi.analyzeFrame({ session_code: session, camera_type: 'primary', image_base64: img })
      const flags = Array.isArray(r?.flags) ? r.flags : []
      flags.forEach((f) => {
        const fl = String(f || '').trim(); if (!fl) return
        if (fl === 'calibrating_gaze_baseline') { void assessmentApi.logEvent({ session_code: session, event_type: fl, severity: 'low', payload: {} }); return }
        if (fl === 'multiple_faces_detected') { closeNow('multiple_faces_detected', { flag: fl }); return }
        if (fl === 'no_face_detected') { void recordViolation('no_face_detected', { severity: 'high', maxWarnings: 3, cooldownMs: 8000 }); return }
        if (fl === 'suspicious_eye_movement' || fl === 'prolonged_offscreen_attention') { void recordViolation('suspicious_eye_movement', { severity: 'medium', payload: { flag: fl }, maxWarnings: 3, cooldownMs: 7000 }); return }
        if (fl === 'suspicious_head_movement') { void recordViolation('suspicious_head_movement', { severity: 'medium', payload: { flag: fl }, maxWarnings: 3, cooldownMs: 8000 }); return }
        if (['suspicious_object_detected', 'cell_phone_detected', 'book_detected', 'multiple_persons_detected', 'laptop_detected', 'monitor_detected'].includes(fl)) { void recordViolation('suspicious_object_detected', { severity: 'high', payload: { flag: fl }, maxWarnings: 3, cooldownMs: 9000 }); return }
        if (fl === 'suspicious_candidate_identity_change') { closeNow('suspicious_candidate_identity_change', { flag: fl }); return }
        pushFlag(`Camera: ${label(fl)}`)
      })
    } catch { /* */ }
  }

  async function sendAudioSample(session) {
    const b = micCtxRef.current; if (!b || !session) return
    try {
      b.analyser.getFloatTimeDomainData(b.data)
      let sum = 0; for (let i = 0; i < b.data.length; i += 1) sum += b.data[i] * b.data[i]
      const rms = Math.sqrt(sum / b.data.length)
      const r = await assessmentApi.analyzeAudio({ session_code: session, rms })
      if (r?.is_anomaly) void recordViolation('audio_anomaly_detected', { severity: 'medium', payload: { rms: Number(rms.toFixed(4)) }, maxWarnings: 3, cooldownMs: 12000 })
    } catch { /* */ }
  }

  function startSpeechRecognition(session) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR || !session) return
    try {
      const rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = 'en-US'
      rec.onresult = (ev) => {
        try {
          let txt = ''; for (let i = ev.resultIndex; i < ev.results.length; i += 1) txt += ev.results[i][0]?.transcript || ''
          txt = txt.trim(); if (!txt) return
          const now = Date.now(); speechBufferRef.current.lastText = txt
          if (now - (speechBufferRef.current.lastSentAt || 0) < 4000) return
          speechBufferRef.current.lastSentAt = now; vadStateRef.current.lastSpeechAt = now
          pushFlag('Speech detected')
          void recordViolation('speech_detected', { severity: 'medium', payload: { transcript: txt.slice(0, 240) }, maxWarnings: 3, cooldownMs: 15000 })
          void assessmentApi.logEvent({ session_code: session, event_type: 'speech_recognition', severity: 'medium', payload: { transcript: txt.slice(0, 240) } })
        } catch { /* */ }
      }
      rec.onerror = () => {}; rec.onend = () => { try { if (running && !result) rec.start() } catch { /* */ } }
      rec.start(); speechRecRef.current = rec
    } catch { /* */ }
  }

  function startVAD(session) {
    const st = vadStateRef.current; st.speaking = false; st.aboveMs = 0; st.lastEventAt = 0
    const id = setInterval(() => {
      try {
        if (!running || result) return
        const b = micCtxRef.current; if (!b) return
        b.analyser.getFloatTimeDomainData(b.data)
        let sum = 0; for (let i = 0; i < b.data.length; i += 1) sum += b.data[i] * b.data[i]
        const rms = Math.sqrt(sum / b.data.length)
        st.aboveMs = rms >= 0.03 ? st.aboveMs + 200 : 0
        const now = Date.now()
        if (!st.speaking && st.aboveMs >= 800) {
          st.speaking = true
          if (now - st.lastEventAt > 5000) {
            st.lastEventAt = now; pushFlag('Voice activity'); void recordViolation('voice_activity_detected', { severity: 'medium', payload: { rms: Number(rms.toFixed(4)) }, maxWarnings: 3, cooldownMs: 12000 })
            if (session) void assessmentApi.logEvent({ session_code: session, event_type: 'voice_activity_detected', severity: 'medium', payload: { rms: Number(rms.toFixed(4)) } })
          }
        }
        if (st.speaking && rms < 0.03) st.speaking = false
      } catch { /* */ }
    }, 200)
    proctorIntervalIdsRef.current.push(id)
  }

  /* ── prechecks ── */
  async function startPrechecks() {
    setError(''); setInfo(''); setSpeakerOk(false); setSpeakerTestPlayed(false)
    try {
      if (!cameraStreamRef.current) cameraStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      if (videoRef.current) { videoRef.current.srcObject = cameraStreamRef.current; await videoRef.current.play() }
      setCameraOk(true)
    } catch (e) { setCameraOk(false); setError(e?.message || 'Camera permission denied.') }
    try {
      if (!micStreamRef.current) micStreamRef.current = await navigator.mediaDevices.getUserMedia({ video: false, audio: true })
      if (!micCtxRef.current) {
        const ctx = new AudioContext(); const src = ctx.createMediaStreamSource(micStreamRef.current)
        const a = ctx.createAnalyser(); a.fftSize = 1024; src.connect(a)
        micCtxRef.current = { ctx, analyser: a, data: new Float32Array(a.fftSize) }
      }
      setMicOk(true)
      if (!micIntervalRef.current) micIntervalRef.current = setInterval(() => {
        try { const b = micCtxRef.current; if (!b) return; b.analyser.getFloatTimeDomainData(b.data); let sum = 0; for (let i = 0; i < b.data.length; i += 1) sum += b.data[i] * b.data[i]; setMicLevel(Math.sqrt(sum / b.data.length)) } catch { /* */ }
      }, 250)
    } catch (e) { setMicOk(false); setError(e?.message || 'Microphone permission denied.') }
  }
  function stopPrechecks() {
    if (micIntervalRef.current) { clearInterval(micIntervalRef.current); micIntervalRef.current = null }
    if (micCtxRef.current?.ctx) micCtxRef.current.ctx.close().catch(() => {}); micCtxRef.current = null
    if (micStreamRef.current) { micStreamRef.current.getTracks().forEach((t) => t.stop()); micStreamRef.current = null }
    if (cameraStreamRef.current) { cameraStreamRef.current.getTracks().forEach((t) => t.stop()); cameraStreamRef.current = null }
  }
  function stopPrecheckMeter() { if (micIntervalRef.current) { clearInterval(micIntervalRef.current); micIntervalRef.current = null } }

  function resetAll() {
    setExam(null); setSessionCode(''); setAnswers({}); setResult(null); setRunning(false); setTimeLeft(0)
    setTerminationReason(''); setCurrentQ(0); setShowConfirmSubmit(false); submissionStateRef.current.inFlight = false
  }

  async function playTestSound() {
    setError('')
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const o = ctx.createOscillator(); const g = ctx.createGain()
      o.type = 'sine'; o.frequency.value = 440; g.gain.value = 0.08
      o.connect(g); g.connect(ctx.destination); o.start()
      setTimeout(() => { try { o.stop(); ctx.close() } catch { /* */ } }, 450)
      setSpeakerTestPlayed(true)
    } catch (e) { setSpeakerOk(false); setError(e?.message || 'Unable to play test sound.') }
  }

  async function prepareAssessment() {
    const code = String(sessionCodeInput || '').trim().toUpperCase()
    if (!code) { setError('Enter the session code from your email.'); return }
    if (!precheckPassed) { setError('Complete all pre-exam checks first.'); return }
    setStarting(true); setError(''); setInfo('Loading assessment…')
    try {
      resetAll()
      const d = await assessmentApi.accessExam(code)
      setSessionCode(d.session_code); setExam(d); setAnswers({}); setResult(null)
      setTimeLeft(Number(d.duration_minutes || 0) * 60)
      tabSwitchCountRef.current = 0; setTabSwitchCount(0); setAntiCheatFlags([]); setViolationCounts({}); setToast('')
      setInfo('')
    } catch (e) { setError(e?.message || 'Unable to load assessment'); setInfo('') }
    finally { setStarting(false) }
  }

  async function beginAssessment() {
    if (!exam || !sessionCode) { setError('Prepare the assessment first.'); return }
    if (!precheckPassed) { setError('Complete all pre-exam checks first.'); return }
    setError(''); setInfo(''); setTerminationReason(''); stopPrecheckMeter(); setRunning(true); setCurrentQ(0)
    fullscreenStateRef.current = { shouldEnforce: true, enteredOnce: false, startAt: Date.now() }
    try { const el = document.documentElement; const r = el.requestFullscreen || el.webkitRequestFullscreen; if (r) await r.call(el) } catch { /* */ }
    setTimeout(() => { try { if (!(document.fullscreenElement || document.webkitFullscreenElement)) tabClose('fullscreen_required_not_entered', { source: 'begin_check' }) } catch { /* */ } }, 900)
    try { await assessmentApi.logEvent({ session_code: sessionCode, event_type: 'exam_started', severity: 'low', payload: { fullscreen: Boolean(document.fullscreenElement) } }) } catch { /* */ }
    stopProctoring()
    proctorIntervalIdsRef.current.push(
      setInterval(() => { void sendCameraFrame(sessionCode) }, 5000),
      setInterval(() => { void sendAudioSample(sessionCode) }, 4000),
    )
    startVAD(sessionCode); startSpeechRecognition(sessionCode)
  }

  /* ── derived ── */
  const timerPct = exam ? (timeLeft / (Number(exam.duration_minutes || 1) * 60)) * 100 : 100
  const urgent = timeLeft > 0 && timeLeft <= 60
  const warn = timeLeft > 60 && timeLeft <= 300
  const curQ = questions[currentQ] || null

  /* ════════════════════════ RENDER ════════════════════════ */
  return (
    <main className="main">
      <section className="ax">

        {/* ──────────── PRECHECK PHASE ──────────── */}
        {!running && !result ? (
          <>
            {/* hero */}
            <div className="ax-hero">
              <div className="ax-hero-icon"><IcoShield size={36} /></div>
              <h1 className="ax-hero-title">Proctored Assessment</h1>
              <p className="ax-hero-sub">Complete the setup below, then start your timed exam. Your camera, microphone, and screen activity are monitored throughout.</p>
            </div>

            {error ? <div className="ax-alert ax-alert--err">{error}</div> : null}
            {info ? <div className="ax-alert ax-alert--info">{info}</div> : null}

            {/* checks card */}
            <div className="ax-card">
              <div className="ax-card-hdr">
                <h2 className="ax-card-title">System Checks</h2>
                <button type="button" className="btn btn-ghost btn-sm" onClick={startPrechecks}>Re-check</button>
              </div>

              <div className="ax-checks">
                {/* camera */}
                <div className={`ax-chk ${cameraOk ? 'ax-chk--ok' : ''}`}>
                  <span className="ax-chk-ico">{cameraOk ? <IcoCheck /> : <IcoCamera />}</span>
                  <div>
                    <div className="ax-chk-lbl">Camera</div>
                    <div className="ax-chk-val">{cameraOk ? 'Connected' : 'Waiting for permission…'}</div>
                  </div>
                </div>
                {/* mic */}
                <div className={`ax-chk ${micOk ? 'ax-chk--ok' : ''}`}>
                  <span className="ax-chk-ico">{micOk ? <IcoCheck /> : <IcoMic />}</span>
                  <div>
                    <div className="ax-chk-lbl">Microphone</div>
                    <div className="ax-chk-val">
                      {micOk ? 'Connected' : 'Waiting for permission…'}
                      {micOk ? <div className="ax-mic-bar"><div className="ax-mic-fill" style={{ width: `${Math.min(100, micLevel * 1200)}%` }} /></div> : null}
                    </div>
                  </div>
                </div>
                {/* speaker */}
                <div className={`ax-chk ${speakerOk ? 'ax-chk--ok' : ''}`}>
                  <span className="ax-chk-ico">{speakerOk ? <IcoCheck /> : <IcoSpeaker />}</span>
                  <div>
                    <div className="ax-chk-lbl">Speaker</div>
                    <div className="ax-chk-val">{speakerOk ? 'Verified' : speakerTestPlayed ? 'Did you hear it?' : 'Not tested'}</div>
                    {!speakerOk ? (
                      <div className="ax-chk-actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={playTestSound}>Play tone</button>
                        {speakerTestPlayed ? <button type="button" className="btn btn-primary btn-sm" onClick={() => { setSpeakerOk(true); setError('') }}>I heard it</button> : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              {/* camera preview */}
              <div className="ax-preview">
                <video className="ax-preview-vid" ref={videoRef} autoPlay muted playsInline />
                <span className="ax-preview-lbl">Live Preview</span>
              </div>
            </div>

            {/* session code + start */}
            <div className="ax-card">
              <h2 className="ax-card-title" style={{ marginBottom: '0.75rem' }}>Enter Session Code</h2>
              <div className="ax-code-row">
                <div style={{ flex: 1 }}>
                  <input
                    className="input ax-code-input"
                    value={sessionCodeInput}
                    onChange={(e) => setSessionCodeInput(e.target.value.toUpperCase())}
                    placeholder="EXAM-XXXXXXXXXX"
                  />
                </div>
                {precheckPassed && hasCode && !exam ? (
                  <button type="button" className="btn btn-primary" onClick={prepareAssessment} disabled={starting}>
                    {starting ? 'Loading…' : 'Load Exam'}
                  </button>
                ) : null}
              </div>

              {exam ? (
                <div className="ax-ready">
                  <div className="ax-ready-chips">
                    <span className="ax-chip">{totalQ} questions</span>
                    <span className="ax-chip">{exam.duration_minutes} min</span>
                    <span className="ax-chip ax-chip--accent">AI-Proctored</span>
                  </div>

                  <div className="ax-ready-rules">
                    <strong>Before you begin:</strong>
                    <ul>
                      <li>Fullscreen is <strong>required</strong> — exiting ends the exam immediately</li>
                      <li>Switching tabs or losing window focus ends the exam</li>
                      <li>Camera, microphone, face detection, and speech recognition remain active</li>
                      <li>Copy, paste, screenshots, and right-click are disabled</li>
                      <li>3-strike warnings for face, eye, head, audio, and object violations</li>
                    </ul>
                  </div>

                  <button type="button" className="btn btn-primary ax-begin-btn" onClick={beginAssessment} disabled={starting}>
                    Begin Assessment
                  </button>
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {/* ──────────── EXAM PHASE ──────────── */}
        {running && exam ? (
          <div className="ax-exam">
            {/* sticky top bar */}
            <header className="ax-bar">
              <div className="ax-bar-left">
                <span className="ax-bar-code">{sessionCode}</span>
                <span className="ax-bar-dot"></span>
                <span className="ax-bar-prog">{answeredCount}/{totalQ} answered</span>
              </div>
              <div className={`ax-bar-timer ${urgent ? 'ax-bar-timer--urgent' : warn ? 'ax-bar-timer--warn' : ''}`}>
                <IcoTimer size={15} />
                <span>{fmt(timeLeft)}</span>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowConfirmSubmit(true)} disabled={Boolean(result)}>
                Submit
              </button>
            </header>

            {/* timer bar */}
            <div className="ax-tbar">
              <div className={`ax-tbar-fill ${urgent ? 'ax-tbar-fill--urgent' : warn ? 'ax-tbar-fill--warn' : ''}`} style={{ width: `${timerPct}%` }} />
            </div>

            {/* warnings strip */}
            {(tabSwitchCount > 0 || Object.keys(violationCounts || {}).length > 0) ? (
              <div className="ax-warns">
                {tabSwitchCount > 0 ? <span className="ax-warn ax-warn--crit">Focus violation ({tabSwitchCount})</span> : null}
                {['suspicious_eye_movement', 'suspicious_head_movement', 'suspicious_object_detected', 'audio_anomaly_detected', 'voice_activity_detected', 'speech_detected', 'no_face_detected']
                  .filter((k) => (violationCounts || {})[k])
                  .map((k) => <span key={k} className="ax-warn">{label(k)} {violationCounts[k].count}/{violationCounts[k].maxWarnings || 3}</span>)}
              </div>
            ) : null}

            {/* question body */}
            <div className="ax-qbody">
              {curQ ? (
                <div className="ax-qcard">
                  <div className="ax-qcard-num">Question {currentQ + 1} <span className="ax-qcard-of">of {totalQ}</span></div>
                  <div className="ax-qcard-txt">{curQ.question}</div>
                  <div className="ax-qcard-opts">
                    {(curQ.options || []).map((opt, i) => {
                      const sel = answers[curQ.id] === opt
                      return (
                        <button key={`${curQ.id}-${i}`} type="button" className={`ax-opt ${sel ? 'ax-opt--sel' : ''}`} onClick={() => { setAnswers((p) => ({ ...p, [curQ.id]: opt })) }}>
                          <span className="ax-opt-letter">{String.fromCharCode(65 + i)}</span>
                          <span className="ax-opt-text">{opt}</span>
                          {sel ? <span className="ax-opt-check"><IcoCheck size={16} /></span> : null}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : null}

              {/* navigation */}
              <div className="ax-qnav">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCurrentQ((p) => Math.max(0, p - 1))} disabled={currentQ === 0}>← Prev</button>
                <div className="ax-qnav-dots">
                  {questions.map((q, i) => (
                    <button key={q.id} type="button" className={`ax-dot ${i === currentQ ? 'ax-dot--cur' : ''} ${answers[q.id] ? 'ax-dot--done' : ''}`} onClick={() => setCurrentQ(i)} title={`Q${i + 1}${answers[q.id] ? ' (answered)' : ''}`}>{i + 1}</button>
                  ))}
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCurrentQ((p) => Math.min(totalQ - 1, p + 1))} disabled={currentQ >= totalQ - 1}>Next →</button>
              </div>
            </div>

            {/* PIP camera */}
            <div className="ax-pip">
              <video ref={videoRef} autoPlay muted playsInline className="ax-pip-vid" />
              <span className="ax-pip-live">LIVE</span>
            </div>

            <canvas ref={frameCanvasRef} style={{ display: 'none' }} />

            {/* confirm modal */}
            {showConfirmSubmit ? (
              <div className="ax-overlay" onClick={() => setShowConfirmSubmit(false)}>
                <div className="ax-modal" onClick={(e) => e.stopPropagation()}>
                  <h3 className="ax-modal-title">Submit Assessment?</h3>
                  <p className="ax-modal-body">
                    You have answered <strong>{answeredCount}</strong> of <strong>{totalQ}</strong> questions.
                    {answeredCount < totalQ ? <span> <strong>{totalQ - answeredCount}</strong> unanswered questions will be scored as incorrect.</span> : null}
                  </p>
                  <div className="ax-modal-btns">
                    <button type="button" className="btn btn-ghost" onClick={() => setShowConfirmSubmit(false)}>Continue Exam</button>
                    <button type="button" className="btn btn-primary" onClick={() => handleSubmit(false)} disabled={submitting}>{submitting ? 'Submitting…' : 'Confirm Submit'}</button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* ──────────── RESULT PHASE ──────────── */}
        {result ? (
          <div className="ax-done">
            <svg className="ax-done-ico" width="72" height="72" viewBox="0 0 72 72" fill="none">
              <circle cx="36" cy="36" r="34" stroke="#22c55e" strokeWidth="3" />
              <path d="M22 37L32 47L50 27" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <h2 className="ax-done-title">Assessment Submitted</h2>
            <p className="ax-done-msg">{terminationReason || 'Your assessment has been submitted successfully.'}</p>
            <p className="ax-done-sub">Your results are being reviewed. You will receive an email with your score and feedback shortly. If you qualify, our team will contact you for the next interview round.</p>
          </div>
        ) : null}

      </section>

      {/* toast */}
      {toast ? <div className="ax-toast">{toast}</div> : null}

      {/* watermark (visible on screenshots) */}
      {running ? <div className="ax-watermark">PROCTORED EXAM &bull; CONFIDENTIAL &bull; {sessionCode}</div> : null}
    </main>
  )
}

export default Assessment
