import { useCallback, useEffect, useRef, useState } from 'react'
import { assessmentApi } from '../assessmentApi'

function formatTime(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds || 0))
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function Assessment() {
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const [violationCounts, setViolationCounts] = useState({}) // { [eventType]: { count: number, maxWarnings: number } }

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
  const [tabSwitchCount, setTabSwitchCount] = useState(0)
  const [antiCheatFlags, setAntiCheatFlags] = useState([])

  const videoRef = useRef(null)
  const frameCanvasRef = useRef(null)
  const cameraStreamRef = useRef(null)
  const micStreamRef = useRef(null)
  const micCtxRef = useRef(null)
  const micIntervalRef = useRef(null)

  const vadStateRef = useRef({
    speaking: false,
    aboveMs: 0,
    lastEventAt: 0,
    lastSpeechAt: 0,
  })

  const speechRecRef = useRef(null)
  const speechBufferRef = useRef({ lastText: '', lastSentAt: 0 })

  const tabSwitchCountRef = useRef(0)
  const proctorIntervalIdsRef = useRef([])
  const proctorListenersRef = useRef([])

  const fullscreenStateRef = useRef({
    shouldEnforce: false,
    enteredOnce: false,
    startAt: 0,
  })

  const violationStateRef = useRef({}) // { [eventType]: { count: number, lastAt: number } }

  const nonBlockingEventRef = useRef({}) // { [eventType]: { lastAt: number, count: number } }
  const streamGuardRef = useRef({
    cameraDeviceId: null,
    micDeviceId: null,
    lastVideoTime: 0,
    frozenStreak: 0,
  })

  const hasCode = Boolean(String(sessionCodeInput || '').trim())
  const precheckPassed = cameraOk && micOk && speakerOk

  const showToast = useCallback((message) => {
    const m = String(message || '').trim()
    if (!m) return
    setToast(m)
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current)
    }
    toastTimeoutRef.current = setTimeout(() => {
      setToast('')
      toastTimeoutRef.current = null
    }, 3500)
  }, [])

  const pushAntiCheatFlag = useCallback((text) => {
    const t = String(text || '').trim()
    if (!t) return
    setAntiCheatFlags((prev) => [t, ...(prev || [])].slice(0, 12))
  }, [])

  const handleSubmit = useCallback(
    async (auto = false, customMessage = '') => {
      if (!sessionCode || !exam || result) return

      setError('')
      try {
        const payload = (exam.questions || []).map((q) => ({ question_id: q.id, answer: answers[q.id] || '' }))
        const submitted = await assessmentApi.submitExam(sessionCode, payload)
        try {
          await assessmentApi.logEvent({
            session_code: sessionCode,
            event_type: 'exam_submitted',
            severity: 'low',
            payload: { auto, tab_switch_count: tabSwitchCountRef.current },
          })
        } catch {
          // ignore
        }
        setResult(submitted)
        setRunning(false)
        setInfo(customMessage || (auto ? 'Test submitted successfully.' : 'Test submitted successfully.'))
        stopProctoring()
        stopPrechecks()
      } catch (err) {
        setError(err?.message || 'Submit failed')
        if (auto) {
          // For policy/time based auto-submit, always end the exam UI even when network submission fails.
          setRunning(false)
          setResult({
            auto_submitted: true,
            submission_failed: true,
          })
          setInfo(customMessage || 'Test ended. Submission sync may have failed; please contact support.')
          stopProctoring()
          stopPrechecks()
        }
      }
    },
    [answers, exam, result, sessionCode],
  )

  const recordViolation = useCallback(
    async (eventType, { severity = 'medium', payload = null, maxWarnings = 3, cooldownMs = 6000, immediateClose = false } = {}) => {
      if (!running || result) return
      const type = String(eventType || 'violation')

      const now = Date.now()
      const prev = violationStateRef.current[type] || { count: 0, lastAt: 0 }
      if (cooldownMs && now - (prev.lastAt || 0) < cooldownMs) {
        return
      }

      const nextCount = (prev.count || 0) + 1
      violationStateRef.current[type] = { count: nextCount, lastAt: now }

      setViolationCounts((current) => ({
        ...(current || {}),
        [type]: { count: nextCount, maxWarnings: Number(maxWarnings || 0) },
      }))

      pushAntiCheatFlag(maxWarnings > 0 ? `${type} (${nextCount}/${maxWarnings})` : type)

      try {
        await assessmentApi.logEvent({
          session_code: sessionCode,
          event_type: type,
          severity,
          payload: { count: nextCount, ...(payload || {}) },
        })
      } catch {
        // ignore
      }

      if (immediateClose) {
        void handleSubmit(true, 'Test submitted successfully. Results will be shared soon.')
        return
      }

      if (maxWarnings > 0) {
        if (nextCount < maxWarnings) {
          const remaining = maxWarnings - nextCount
          showToast(`Anti-cheat warning: ${type}. Warning ${nextCount}/${maxWarnings}. Remaining attempts: ${remaining}.`)
          return
        }

        // Disqualify immediately on the final warning.
        if (nextCount === maxWarnings) {
          showToast(`Anti-cheat warning: ${type}. Final warning (${maxWarnings}/${maxWarnings}). You are disqualified.`)
          void handleSubmit(true, 'Test submitted successfully. Results will be shared soon.')
          return
        }
      }

      void handleSubmit(true, 'Test submitted successfully. Results will be shared soon.')
    },
    [handleSubmit, pushAntiCheatFlag, result, running, sessionCode, showToast],
  )

  const logNonBlockingEvent = useCallback(
    async (eventType, { severity = 'medium', payload = null, cooldownMs = 12000, maxAlerts = 2 } = {}) => {
      if (!running || result) return
      const type = String(eventType || 'event')

      const now = Date.now()
      const prev = nonBlockingEventRef.current[type] || { lastAt: 0, count: 0 }
      if (cooldownMs && now - (prev.lastAt || 0) < cooldownMs) return
      const nextCount = (prev.count || 0) + 1
      nonBlockingEventRef.current[type] = { lastAt: now, count: nextCount }

      pushAntiCheatFlag(type)
      try {
        await assessmentApi.logEvent({
          session_code: sessionCode,
          event_type: type,
          severity,
          payload: { count: nextCount, ...(payload || {}) },
        })
      } catch {
        // ignore
      }

      if (nextCount <= maxAlerts) {
        try {
          showToast(`Anti-cheat warning: ${type}.`)
        } catch {
          // ignore
        }
      }
    },
    [pushAntiCheatFlag, result, running, sessionCode, showToast],
  )

  const closeExamImmediately = useCallback(
    (eventType, payload = null) => {
      if (!running || result) return
      showToast(`Anti-cheat violation: ${eventType}. Test will be auto-submitted.`)
      void recordViolation(eventType, {
        severity: 'high',
        payload,
        immediateClose: true,
        maxWarnings: 0,
        cooldownMs: 0,
      })
    },
    [recordViolation, result, running, showToast],
  )

  const registerTabSwitchAndClose = useCallback(
    (eventType, payload = null) => {
      if (!running || result) return
      tabSwitchCountRef.current += 1
      const next = tabSwitchCountRef.current
      setTabSwitchCount(next)
      closeExamImmediately(eventType, { tab_switch_count: next, ...(payload || {}) })
    },
    [closeExamImmediately, result, running],
  )

  useEffect(() => {
    const queryCode = new URLSearchParams(window.location.search).get('code')
    if (queryCode) {
      setSessionCodeInput(String(queryCode).trim().toUpperCase())
    }

    startPrechecks()

    return () => {
      stopProctoring()
      stopPrechecks()
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current)
        toastTimeoutRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!running || timeLeft <= 0) return
    const timer = setInterval(() => {
      setTimeLeft((value) => {
        if (value <= 1) {
          clearInterval(timer)
          handleSubmit(true, 'Time ended. Auto-submitted.')
          return 0
        }
        return value - 1
      })
    }, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, timeLeft])

  useEffect(() => {
    if (!running || result) return

    const getFullscreenElement = () =>
      document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement

    const isFullscreen = () => Boolean(getFullscreenElement())

    const onVisibilityChange = () => {
      if (document.hidden) registerTabSwitchAndClose('tab_switch_detected', { source: 'visibilitychange' })
      else {
        // When user comes back, try to re-enter fullscreen.
        try {
          const el = document.documentElement
          const request = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen
          if (!isFullscreen() && request) {
            void request.call(el)
          }
        } catch {
          // ignore
        }
      }
    }

    const onBlur = () => {
      registerTabSwitchAndClose('window_blur', { source: 'blur' })
    }

    const onPageHide = () => {
      registerTabSwitchAndClose('page_hidden', { source: 'pagehide' })
    }

    const onFocusOut = () => {
      if (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())) {
        registerTabSwitchAndClose('focus_lost', { source: 'focusout' })
      }
    }

    const onFullscreenChange = () => {
      if (!isFullscreen()) {
        registerTabSwitchAndClose('fullscreen_exited', { source: 'fullscreenchange' })
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onBlur)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('focusout', onFocusOut)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.addEventListener('webkitfullscreenchange', onFullscreenChange)

    // Focus + fullscreen guard: some environments don't reliably emit blur/visibilitychange/fullscreenchange.
    // Poll for focus loss (e.g., Alt+Tab) and fullscreen exit and close immediately.
    const focusGuardId = setInterval(() => {
      try {
        if (!running || result) return

        const fs = fullscreenStateRef.current
        if (fs.shouldEnforce) {
          const inFs = isFullscreen()
          if (inFs) fs.enteredOnce = true

          // If the user never entered fullscreen shortly after start, end the exam.
          if (!fs.enteredOnce && fs.startAt && Date.now() - fs.startAt > 2500) {
            registerTabSwitchAndClose('fullscreen_required_not_entered', { source: 'fullscreen_guard' })
            return
          }

          // If fullscreen was entered once and later exited, end the exam.
          if (fs.enteredOnce && !inFs) {
            registerTabSwitchAndClose('fullscreen_exited', { source: 'fullscreen_guard' })
            return
          }
        }

        if (document.hidden || (typeof document.hasFocus === 'function' && !document.hasFocus())) {
          registerTabSwitchAndClose('focus_lost', { source: 'focus_guard' })
        }
      } catch {
        // ignore
      }
    }, 120)

    proctorListenersRef.current.push(
      { target: document, event: 'visibilitychange', handler: onVisibilityChange },
      { target: window, event: 'blur', handler: onBlur },
      { target: window, event: 'pagehide', handler: onPageHide },
      { target: window, event: 'focusout', handler: onFocusOut },
      { target: document, event: 'fullscreenchange', handler: onFullscreenChange },
      { target: document, event: 'webkitfullscreenchange', handler: onFullscreenChange },
    )

    proctorIntervalIdsRef.current.push(focusGuardId)

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
      clearInterval(focusGuardId)
    }
  }, [registerTabSwitchAndClose, result, running])

  useEffect(() => {
    if (!running || result) return

    // Device/stream tamper detection: stop/revoke/freeze/device-change.
    const guard = streamGuardRef.current
    guard.frozenStreak = 0
    guard.lastVideoTime = 0

    const video = videoRef.current
    const cameraStream = cameraStreamRef.current
    const micStream = micStreamRef.current

    const cameraTrack = cameraStream?.getVideoTracks?.()[0]
    const micTrack = micStream?.getAudioTracks?.()[0]

    try {
      guard.cameraDeviceId = cameraTrack?.getSettings?.().deviceId || null
      guard.micDeviceId = micTrack?.getSettings?.().deviceId || null
    } catch {
      // ignore
    }

    const onCameraEnded = () => closeExamImmediately('camera_stream_ended', { source: 'track_ended' })
    const onMicEnded = () => closeExamImmediately('mic_stream_ended', { source: 'track_ended' })

    const onCameraMute = () => closeExamImmediately('camera_track_muted', { source: 'track_mute' })
    const onMicMute = () => closeExamImmediately('mic_track_muted', { source: 'track_mute' })

    if (cameraTrack) {
      cameraTrack.addEventListener?.('ended', onCameraEnded)
      cameraTrack.addEventListener?.('mute', onCameraMute)
    }
    if (micTrack) {
      micTrack.addEventListener?.('ended', onMicEnded)
      micTrack.addEventListener?.('mute', onMicMute)
    }

    const guardId = setInterval(async () => {
      try {
        if (!running || result) return

        // Permission revoked (best-effort).
        if (navigator.permissions?.query) {
          try {
            const camPerm = await navigator.permissions.query({ name: 'camera' })
            if (camPerm?.state === 'denied') {
              closeExamImmediately('camera_permission_revoked', { source: 'permissions_api' })
              return
            }
          } catch {
            // ignore
          }

          try {
            const micPerm = await navigator.permissions.query({ name: 'microphone' })
            if (micPerm?.state === 'denied') {
              closeExamImmediately('mic_permission_revoked', { source: 'permissions_api' })
              return
            }
          } catch {
            // ignore
          }
        }

        // Track/device changes.
        try {
          const nextCamId = cameraTrack?.getSettings?.().deviceId || null
          if (guard.cameraDeviceId && nextCamId && nextCamId !== guard.cameraDeviceId) {
            closeExamImmediately('camera_device_changed', { from: guard.cameraDeviceId, to: nextCamId })
            return
          }
        } catch {
          // ignore
        }

        try {
          const nextMicId = micTrack?.getSettings?.().deviceId || null
          if (guard.micDeviceId && nextMicId && nextMicId !== guard.micDeviceId) {
            closeExamImmediately('mic_device_changed', { from: guard.micDeviceId, to: nextMicId })
            return
          }
        } catch {
          // ignore
        }

        // Frozen video heuristic: currentTime not advancing while stream is live.
        if (video && cameraTrack?.readyState === 'live') {
          const hasPixels = Boolean(video.videoWidth && video.videoHeight)
          if (!hasPixels) {
            closeExamImmediately('camera_no_video_signal', { source: 'video_dimensions' })
            return
          }

          const t = Number(video.currentTime || 0)
          if (guard.lastVideoTime && t <= guard.lastVideoTime + 0.01) guard.frozenStreak += 1
          else guard.frozenStreak = 0
          guard.lastVideoTime = t

          if (guard.frozenStreak >= 6) {
            closeExamImmediately('camera_video_frozen', { source: 'currentTime', frozen_streak: guard.frozenStreak })
          }
        }
      } catch {
        // ignore
      }
    }, 1000)

    proctorIntervalIdsRef.current.push(guardId)

    return () => {
      clearInterval(guardId)
      try {
        cameraTrack?.removeEventListener?.('ended', onCameraEnded)
        cameraTrack?.removeEventListener?.('mute', onCameraMute)
        micTrack?.removeEventListener?.('ended', onMicEnded)
        micTrack?.removeEventListener?.('mute', onMicMute)
      } catch {
        // ignore
      }
    }
  }, [closeExamImmediately, result, running])

  useEffect(() => {
    if (!running || result) return

    // DevTools detection (best-effort): warn + log only, never auto-submit.
    const devToolsId = setInterval(() => {
      try {
        if (!running || result) return
        const dW = Math.abs((window.outerWidth || 0) - (window.innerWidth || 0))
        const dH = Math.abs((window.outerHeight || 0) - (window.innerHeight || 0))
        const suspected = dW > 180 || dH > 180
        if (!suspected) return

        void logNonBlockingEvent('devtools_suspected', {
          severity: 'medium',
          payload: { outerWidth: window.outerWidth, innerWidth: window.innerWidth, outerHeight: window.outerHeight, innerHeight: window.innerHeight, dW, dH },
          cooldownMs: 15000,
          maxAlerts: 2,
        })
      } catch {
        // ignore
      }
    }, 1500)

    proctorIntervalIdsRef.current.push(devToolsId)
    return () => clearInterval(devToolsId)
  }, [logNonBlockingEvent, result, running])

  useEffect(() => {
    if (!running || result) return

    const logBlock = (eventType, payload) => {
      pushAntiCheatFlag(`Blocked: ${eventType}`)
      try {
        void assessmentApi.logEvent({
          session_code: sessionCode,
          event_type: eventType,
          severity: 'medium',
          payload: payload || null,
        })
      } catch {
        // ignore
      }
    }

    const onCopy = (e) => {
      e.preventDefault()
      logBlock('copy_blocked', { source: 'clipboard' })
    }
    const onCut = (e) => {
      e.preventDefault()
      logBlock('cut_blocked', { source: 'clipboard' })
    }
    const onPaste = (e) => {
      e.preventDefault()
      logBlock('paste_blocked', { source: 'clipboard' })
    }

    const onContextMenu = (e) => {
      e.preventDefault()
      logBlock('context_menu_blocked', { source: 'contextmenu' })
    }

    const onKeyDown = (e) => {
      const key = String(e.key || '').toLowerCase()
      const ctrl = e.ctrlKey || e.metaKey
      const alt = e.altKey
      const shift = e.shiftKey

      // Clipboard shortcuts
      if (ctrl && ['c', 'v', 'x'].includes(key)) {
        e.preventDefault()
        logBlock('clipboard_shortcut_blocked', { key: e.key, ctrl, shift, alt })
        return
      }

      // DevTools / view-source / print / save
      if (key === 'f12' || (ctrl && shift && key === 'i') || (ctrl && shift && key === 'j') || (ctrl && key === 'u')) {
        e.preventDefault()
        logBlock('devtools_shortcut_blocked', { key: e.key, ctrl, shift, alt })
        return
      }

      if (ctrl && key === 'p') {
        e.preventDefault()
        logBlock('print_shortcut_blocked', { key: e.key })
        return
      }

      if (ctrl && key === 's') {
        e.preventDefault()
        logBlock('save_shortcut_blocked', { key: e.key })
      }
    }

    document.addEventListener('copy', onCopy)
    document.addEventListener('cut', onCut)
    document.addEventListener('paste', onPaste)
    document.addEventListener('contextmenu', onContextMenu)
    window.addEventListener('keydown', onKeyDown)

    proctorListenersRef.current.push(
      { target: document, event: 'copy', handler: onCopy },
      { target: document, event: 'cut', handler: onCut },
      { target: document, event: 'paste', handler: onPaste },
      { target: document, event: 'contextmenu', handler: onContextMenu },
      { target: window, event: 'keydown', handler: onKeyDown },
    )

    return () => {
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('cut', onCut)
      document.removeEventListener('paste', onPaste)
      document.removeEventListener('contextmenu', onContextMenu)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [pushAntiCheatFlag, result, running, sessionCode])

  useEffect(() => {
    if (!running || result) return
    // Make sure camera preview stays bound to the current <video> element.
    if (cameraStreamRef.current && videoRef.current) {
      videoRef.current.srcObject = cameraStreamRef.current
      videoRef.current.play().catch(() => {})
    }
  }, [running, result])

  function stopProctoring() {
    proctorIntervalIdsRef.current.forEach((id) => clearInterval(id))
    proctorIntervalIdsRef.current = []

    proctorListenersRef.current.forEach(({ target, event, handler }) => {
      target.removeEventListener(event, handler)
    })
    proctorListenersRef.current = []

    try {
      if (speechRecRef.current) {
        speechRecRef.current.onresult = null
        speechRecRef.current.onerror = null
        speechRecRef.current.onend = null
        speechRecRef.current.stop()
      }
    } catch {
      // ignore
    }
    speechRecRef.current = null
  }

  async function sendCameraFrame(session) {
    const video = videoRef.current
    const canvas = frameCanvasRef.current
    if (!video || !canvas || !session) return
    if (!video.videoWidth || !video.videoHeight) return

    const ctx = canvas.getContext('2d')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const image_base64 = canvas.toDataURL('image/jpeg', 0.7)
    try {
      const result = await assessmentApi.analyzeFrame({
        session_code: session,
        camera_type: 'primary',
        image_base64,
      })

      const flags = Array.isArray(result?.flags) ? result.flags : []

      flags.forEach((flag) => {
        const f = String(flag || '').trim()
        if (!f) return

        if (f === 'calibrating_gaze_baseline') {
          // Calibration is expected behavior; log only.
          void assessmentApi.logEvent({
            session_code: session,
            event_type: 'calibrating_gaze_baseline',
            severity: 'low',
            payload: { source_flag: f },
          })
          return
        }

        // Map backend flags -> enforcement events.
        if (f === 'multiple_faces_detected') {
          void recordViolation('multiple_faces_detected', { severity: 'high', maxWarnings: 3, cooldownMs: 8000 })
          return
        }
        if (f === 'no_face_detected') {
          void recordViolation('no_face_detected', { severity: 'high', maxWarnings: 3, cooldownMs: 8000 })
          return
        }
        if (f === 'suspicious_eye_movement' || f === 'prolonged_offscreen_attention') {
          void recordViolation('suspicious_eye_movement', {
            severity: 'medium',
            payload: { source_flag: f },
            maxWarnings: 3,
            cooldownMs: 7000,
          })
          return
        }

        if (f === 'suspicious_head_movement') {
          void recordViolation('suspicious_head_movement', {
            severity: 'medium',
            payload: { source_flag: f },
            maxWarnings: 3,
            cooldownMs: 8000,
          })
          return
        }
        if (f === 'suspicious_object_detected' || f === 'cell_phone_detected' || f === 'book_detected') {
          void recordViolation('suspicious_object_detected', {
            severity: 'high',
            payload: { source_flag: f },
            maxWarnings: 3,
            cooldownMs: 9000,
          })
          return
        }

        if (f === 'multiple_persons_detected' || f === 'laptop_detected' || f === 'monitor_detected') {
          void recordViolation('suspicious_object_detected', {
            severity: 'high',
            payload: { source_flag: f },
            maxWarnings: 3,
            cooldownMs: 9000,
          })
          return
        }

        // Default: just surface as a flag.
        pushAntiCheatFlag(`Camera: ${f}`)
      })
    } catch {
      // ignore transient failures
    }
  }

  async function sendAudioSample(session) {
    const bundle = micCtxRef.current
    if (!bundle || !session) return

    try {
      bundle.analyser.getFloatTimeDomainData(bundle.data)
      let sum = 0
      for (let i = 0; i < bundle.data.length; i += 1) sum += bundle.data[i] * bundle.data[i]
      const rms = Math.sqrt(sum / bundle.data.length)
      const result = await assessmentApi.analyzeAudio({ session_code: session, rms })
      if (result?.is_anomaly) {
        void recordViolation('audio_anomaly_detected', {
          severity: 'medium',
          payload: { event_type: String(result?.event_type || 'audio_anomaly'), rms: Number(rms.toFixed(4)) },
          maxWarnings: 3,
          cooldownMs: 12000,
        })
      }
    } catch {
      // ignore
    }
  }

  function startSpeechRecognition(session) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SpeechRecognition || !session) return

    try {
      const rec = new SpeechRecognition()
      rec.continuous = true
      rec.interimResults = true
      rec.lang = 'en-US'

      rec.onresult = (event) => {
        try {
          let text = ''
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            text += `${event.results[i][0]?.transcript || ''}`
          }
          text = String(text || '').trim()
          if (!text) return

          const now = Date.now()
          speechBufferRef.current.lastText = text

          // Debounce logs to avoid spamming.
          if (now - (speechBufferRef.current.lastSentAt || 0) < 4000) return
          speechBufferRef.current.lastSentAt = now
          vadStateRef.current.lastSpeechAt = now

          pushAntiCheatFlag('Speech detected')
          void recordViolation('speech_detected', {
            severity: 'medium',
            payload: { transcript: text.slice(0, 240) },
            maxWarnings: 3,
            cooldownMs: 15000,
          })
          void assessmentApi.logEvent({
            session_code: session,
            event_type: 'speech_recognition',
            severity: 'medium',
            payload: { transcript: text.slice(0, 240) },
          })
        } catch {
          // ignore
        }
      }

      rec.onerror = () => {
        // ignore
      }

      rec.onend = () => {
        // In some browsers it stops automatically; try to resume while running.
        try {
          if (running && !result) rec.start()
        } catch {
          // ignore
        }
      }

      rec.start()
      speechRecRef.current = rec
    } catch {
      // ignore
    }
  }

  function startVAD(session) {
    const state = vadStateRef.current
    state.speaking = false
    state.aboveMs = 0
    state.lastEventAt = 0

    const vadInterval = setInterval(() => {
      try {
        if (!running || result) return
        const bundle = micCtxRef.current
        if (!bundle) return
        bundle.analyser.getFloatTimeDomainData(bundle.data)
        let sum = 0
        for (let i = 0; i < bundle.data.length; i += 1) sum += bundle.data[i] * bundle.data[i]
        const rms = Math.sqrt(sum / bundle.data.length)

        // Simple energy-based VAD.
        const threshold = 0.03
        const frameMs = 200
        const above = rms >= threshold
        state.aboveMs = above ? state.aboveMs + frameMs : 0

        const now = Date.now()
        if (!state.speaking && state.aboveMs >= 800) {
          state.speaking = true
          // Debounce event logging.
          if (now - state.lastEventAt > 5000) {
            state.lastEventAt = now
            pushAntiCheatFlag('Voice activity detected')
            void recordViolation('voice_activity_detected', {
              severity: 'medium',
              payload: { rms: Number(rms.toFixed(4)) },
              maxWarnings: 3,
              cooldownMs: 12000,
            })
            if (session) {
              void assessmentApi.logEvent({
                session_code: session,
                event_type: 'voice_activity_detected',
                severity: 'medium',
                payload: { rms: Number(rms.toFixed(4)) },
              })
            }
          }
        }

        if (state.speaking && !above) {
          state.speaking = false
        }
      } catch {
        // ignore
      }
    }, 200)

    proctorIntervalIdsRef.current.push(vadInterval)
  }

  async function startPrechecks() {
    setError('')
    setInfo('Allow camera + microphone access to continue.')
    setSpeakerOk(false)
    setSpeakerTestPlayed(false)

    // Camera
    try {
      if (!cameraStreamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        cameraStreamRef.current = stream
      }
      if (videoRef.current) {
        videoRef.current.srcObject = cameraStreamRef.current
        await videoRef.current.play()
      }
      setCameraOk(true)
    } catch (err) {
      setCameraOk(false)
      setError(err?.message || 'Camera permission denied or unavailable.')
    }

    // Microphone
    try {
      if (!micStreamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true })
        micStreamRef.current = stream
      }

      if (!micCtxRef.current) {
        const ctx = new AudioContext()
        const source = ctx.createMediaStreamSource(micStreamRef.current)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        const data = new Float32Array(analyser.fftSize)
        micCtxRef.current = { ctx, analyser, data }
      }

      setMicOk(true)
      if (!micIntervalRef.current) {
        micIntervalRef.current = setInterval(() => {
          try {
            const bundle = micCtxRef.current
            if (!bundle) return
            bundle.analyser.getFloatTimeDomainData(bundle.data)
            let sum = 0
            for (let i = 0; i < bundle.data.length; i += 1) sum += bundle.data[i] * bundle.data[i]
            const rms = Math.sqrt(sum / bundle.data.length)
            setMicLevel(Number.isFinite(rms) ? rms : 0)
          } catch {
            // ignore
          }
        }, 250)
      }
    } catch (err) {
      setMicOk(false)
      setError(err?.message || 'Microphone permission denied or unavailable.')
    }
  }

  function stopPrechecks() {
    if (micIntervalRef.current) {
      clearInterval(micIntervalRef.current)
      micIntervalRef.current = null
    }

    if (micCtxRef.current?.ctx) {
      micCtxRef.current.ctx.close().catch(() => {})
    }
    micCtxRef.current = null

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop())
      micStreamRef.current = null
    }

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop())
      cameraStreamRef.current = null
    }
  }

  function stopPrecheckMeter() {
    if (micIntervalRef.current) {
      clearInterval(micIntervalRef.current)
      micIntervalRef.current = null
    }
  }

  async function playTestSound() {
    setError('')
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = 440
      gain.gain.value = 0.08
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start()
      setTimeout(() => {
        try {
          oscillator.stop()
          ctx.close().catch(() => {})
        } catch {
          // ignore
        }
      }, 450)
      setSpeakerTestPlayed(true)
    } catch (err) {
      setSpeakerOk(false)
      setSpeakerTestPlayed(false)
      setError(err?.message || 'Unable to play test sound.')
    }
  }

  function confirmSpeakerHeard() {
    setSpeakerOk(true)
    setError('')
  }

  function onAnswer(questionId, option) {
    setAnswers((prev) => ({ ...prev, [questionId]: option }))
  }

  async function startAssessment() {
    const code = String(sessionCodeInput || '').trim().toUpperCase()
    if (!code) {
      setError('Please enter the session code from your email.')
      return
    }
    if (!precheckPassed) {
      setError('Complete all pre-exam checks before starting.')
      return
    }

    setStarting(true)
    setError('')
    setInfo('Loading assessment…')

    try {
      const data = await assessmentApi.accessExam(code)
      setSessionCode(data.session_code)
      setExam(data)
      setAnswers({})
      setResult(null)
      setTimeLeft(Number(data.duration_minutes || 0) * 60)
      tabSwitchCountRef.current = 0
      setTabSwitchCount(0)
      setRunning(true)
      setInfo('Assessment started.')
      setAntiCheatFlags([])
      setViolationCounts({})
      setToast('')
      stopPrecheckMeter()

      fullscreenStateRef.current = { shouldEnforce: true, enteredOnce: false, startAt: Date.now() }

      try {
        const el = document.documentElement
        const request = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen
        if (request) await request.call(el)
      } catch {
        // ignore fullscreen failures
      }

      // If fullscreen couldn't be entered, close quickly (guard interval is a backup).
      setTimeout(() => {
        try {
          const getFullscreenElement = () =>
            document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement
          if (!getFullscreenElement()) {
            registerTabSwitchAndClose('fullscreen_required_not_entered', { source: 'startAssessment_check' })
          }
        } catch {
          // ignore
        }
      }, 900)

      try {
        await assessmentApi.logEvent({
          session_code: data.session_code,
          event_type: 'exam_started',
          severity: 'low',
          payload: {
            fullscreen: Boolean(
              document.fullscreenElement ||
                document.webkitFullscreenElement ||
                document.mozFullScreenElement ||
                document.msFullscreenElement,
            ),
          },
        })
      } catch {
        // ignore
      }

      // Periodic proctoring checks (no visible UI)
      stopProctoring()
      proctorIntervalIdsRef.current.push(
        setInterval(() => {
          void sendCameraFrame(data.session_code)
        }, 5000),
        setInterval(() => {
          void sendAudioSample(data.session_code)
        }, 4000),
      )

      startVAD(data.session_code)
      startSpeechRecognition(data.session_code)
    } catch (err) {
      setError(err?.message || 'Unable to start assessment')
      setInfo('')
    } finally {
      setStarting(false)
    }
  }

  return (
    <main className="main">
      <section className="dashboard-page assessment-page">
        <div className="page-header">
          <h1 className="page-title">Assessment</h1>
          <p className="page-subtitle">Complete pre-exam checks to begin.</p>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}
        {info ? <div className="error-banner">{info}</div> : null}

        {!running && !result ? (
          <article className="card" style={{ marginTop: '1rem' }}>
            <div className="card-header">
              <div>
                <h2 className="card-title">Pre-exam checks</h2>
                <p className="card-subtitle">Camera, microphone, and audio output must work.</p>
              </div>
              <button type="button" className="btn btn-ghost" onClick={startPrechecks}>
                Re-check
              </button>
            </div>

            <div className="detail-grid" style={{ marginTop: '1rem' }}>
              <div className="detail-item">
                <div className="detail-label">Camera</div>
                <div className="detail-value">{cameraOk ? 'Passed' : 'Not ready'}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Microphone</div>
                <div className="detail-value">
                  {micOk ? 'Passed' : 'Not ready'}
                  <div className="muted" style={{ marginTop: '0.35rem' }}>
                    Input level: {Math.round(micLevel * 1000)}
                  </div>
                </div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Audio (speaker)</div>
                <div className="detail-value">{speakerOk ? 'Passed' : speakerTestPlayed ? 'Played (confirm)' : 'Not checked'}</div>
              </div>
              <div className="detail-item" style={{ gridColumn: '1 / -1' }}>
                <div className="detail-label">Preview</div>
                <div className="detail-value">
                  <video className="assessment-video" ref={videoRef} autoPlay muted playsInline />
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
              <button type="button" className="btn btn-ghost" onClick={playTestSound}>
                Play test sound
              </button>

              {speakerTestPlayed && !speakerOk ? (
                <button type="button" className="btn btn-primary" onClick={confirmSpeakerHeard}>
                  I heard the sound
                </button>
              ) : null}

              <div style={{ flex: 1, minWidth: 240 }}>
                <label className="label" htmlFor="sessionCode">
                  Session code
                </label>
                <input
                  id="sessionCode"
                  className="input"
                  value={sessionCodeInput}
                  onChange={(e) => setSessionCodeInput(e.target.value.toUpperCase())}
                  placeholder="EXAM-XXXXXXXXXX"
                />
                <div className="muted" style={{ marginTop: '0.35rem' }}>
                  Enter the code sent in your email.
                </div>
              </div>

              {precheckPassed && hasCode ? (
                <button type="button" className="btn btn-primary" onClick={startAssessment} disabled={starting}>
                  {starting ? 'Starting…' : 'Start assessment'}
                </button>
              ) : null}
            </div>
          </article>
        ) : null}

        {running && exam ? (
          <article className="card" style={{ marginTop: '1rem' }}>
            <div className="card-header">
              <div>
                <h2 className="card-title">Test</h2>
                <p className="card-subtitle">
                  Code {sessionCode} · Time left {formatTime(timeLeft)}
                </p>
              </div>
            </div>

            {tabSwitchCount > 0 ? (
              <div className="error-text" style={{ marginBottom: '0.75rem' }}>
                Tab/focus/fullscreen violation detected ({tabSwitchCount}). This closes the test immediately.
              </div>
            ) : null}

            {Object.keys(violationCounts || {}).length ? (
              <div className="error-banner" style={{ marginBottom: '0.75rem' }}>
                <div style={{ fontWeight: 650, marginBottom: '0.35rem' }}>Warnings (3-strike rule)</div>
                {[
                  'suspicious_eye_movement',
                  'suspicious_head_movement',
                  'suspicious_object_detected',
                  'audio_anomaly_detected',
                  'voice_activity_detected',
                  'speech_detected',
                  'multiple_faces_detected',
                  'no_face_detected',
                ]
                  .filter((k) => (violationCounts || {})[k])
                  .map((k) => (
                    <div key={k} className="muted">
                      • {k}: {(violationCounts || {})[k].count}/{(violationCounts || {})[k].maxWarnings || 3}
                    </div>
                  ))}
              </div>
            ) : null}

            {antiCheatFlags.length ? (
              <div className="error-banner" style={{ marginBottom: '0.75rem' }}>
                <div style={{ fontWeight: 650, marginBottom: '0.35rem' }}>Anti-cheat</div>
                {antiCheatFlags.slice(0, 5).map((flag, idx) => (
                  <div key={`${flag}-${idx}`} className="muted">
                    • {flag}
                  </div>
                ))}
              </div>
            ) : null}

            {(exam.questions || []).map((q) => (
              <div className="assessment-question" key={q.id}>
                <div style={{ fontWeight: 650 }}>
                  Q{q.id}. {q.question}
                </div>
                {(q.options || []).map((opt) => (
                  <label className="assessment-option" key={`${q.id}-${opt}`}>
                    <input
                      type="radio"
                      name={`q-${q.id}`}
                      checked={answers[q.id] === opt}
                      onChange={() => onAnswer(q.id, opt)}
                    />
                    <span>{opt}</span>
                  </label>
                ))}
              </div>
            ))}

            <button type="button" className="btn btn-primary" onClick={() => handleSubmit(false)} disabled={Boolean(result)}>
              Submit
            </button>

            <video ref={videoRef} autoPlay muted playsInline style={{ display: 'none' }} />
            <canvas ref={frameCanvasRef} style={{ display: 'none' }} />
          </article>
        ) : null}

        {result ? (
          <article className="card" style={{ marginTop: '1rem' }}>
            <div className="card-header">
              <div>
                <h2 className="card-title">Result</h2>
                <p className="card-subtitle">Assessment submitted.</p>
              </div>
            </div>
            <div>Test submitted successfully.</div>
            <div className="muted" style={{ marginTop: '0.35rem' }}>Your results will be shared soon.</div>
          </article>
        ) : null}
      </section>

      {toast ? <div className="toast">{toast}</div> : null}
    </main>
  )
}

export default Assessment
