import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

/**
 * Shared ChatWidget component used for both candidate and admin chatbots.
 *
 * Props:
 *  - sendMessage(message, history) => Promise<{ reply, action? }>
 *  - title: string (e.g. "Career Assistant" or "Admin Assistant")
 *  - greeting: string (initial bot message)
 *  - placeholder: string (input placeholder)
 *  - accentClass: string (optional CSS class variant)
 *  - onAction: (action) => void (optional callback when AI returns an action)
 */
export default function ChatWidget({ sendMessage, title, greeting, placeholder, onAction }) {
  const [open, setOpen] = useState(false)
  const [sessionId, setSessionId] = useState(() => Date.now())
  const [messages, setMessages] = useState([{ role: 'bot', content: greeting }])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    if (open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, open])

  function handleOpen() {
    if (open) {
      setOpen(false)
    } else {
      // New session on every open
      setSessionId(Date.now())
      setMessages([{ role: 'bot', content: greeting }])
      setInput('')
      setLoading(false)
      setOpen(true)
    }
  }

  async function handleSend() {
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    setMessages((prev) => [...prev, { role: 'user', content: text }])
    setLoading(true)
    try {
      const history = messages.map((m) => ({
        role: m.role === 'bot' ? 'assistant' : 'user',
        content: m.content,
      }))
      const res = await sendMessage(text, history)
      const reply = res?.reply || 'Sorry, I could not get a response.'
      setMessages((prev) => [...prev, { role: 'bot', content: reply }])
      if (res?.action && onAction) {
        onAction(res.action)
      }
    } catch {
      setMessages((prev) => [...prev, { role: 'bot', content: 'Sorry, I ran into an error. Please try again.' }])
    } finally {
      setLoading(false)
    }
  }

  // Strip hidden ```json ... ``` blocks from display text
  function stripJsonBlocks(text) {
    if (!text) return ''
    return text.replace(/```json[\s\S]*?```/g, '').replace(/```[\s\S]*?```/g, '').trim()
  }

  // Render markdown-like content with link support
  function renderContent(text) {
    if (!text) return null
    // Split by markdown links: [text](url)
    const parts = text.split(/(\[[^\]]+\]\([^)]+\))/g)
    return parts.map((part, i) => {
      const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (linkMatch) {
        const label = linkMatch[1]
        const href = linkMatch[2]
        // Internal links use Link, external use <a>
        if (href.startsWith('/')) {
          return (
            <Link key={i} to={href} className="chat-link" onClick={() => setOpen(false)}>
              {label}
            </Link>
          )
        }
        return (
          <a key={i} href={href} target="_blank" rel="noopener noreferrer" className="chat-link">
            {label}
          </a>
        )
      }
      // Bold: **text**
      const boldParts = part.split(/(\*\*[^*]+\*\*)/g)
      return boldParts.map((bp, j) => {
        const boldMatch = bp.match(/^\*\*([^*]+)\*\*$/)
        if (boldMatch) return <strong key={`${i}-${j}`}>{boldMatch[1]}</strong>
        return <span key={`${i}-${j}`}>{bp}</span>
      })
    })
  }

  return (
    <>
      {open && (
        <div className="chatbot-panel">
          <div className="chatbot-panel-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--gradient-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              </div>
              <span style={{ fontWeight: 600 }}>{title}</span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={handleOpen} style={{ padding: '0.2rem 0.4rem', fontSize: '1rem', lineHeight: 1 }}>×</button>
          </div>
          <div className="chatbot-messages">
            {messages.map((msg, i) => (
              <div key={`${sessionId}-${i}`} className={`chat-bubble ${msg.role === 'user' ? 'chat-bubble-user' : 'chat-bubble-bot'}`}>
                {msg.role === 'bot' ? (
                  <div className="chat-md-content">
                    {stripJsonBlocks(msg.content).split('\n').map((line, li) => {
                      const bullet = line.match(/^[-*]\s+(.+)$/)
                      if (bullet) {
                        return (
                          <div key={li} className="chat-bullet">
                            <span className="chat-bullet-dot">•</span>
                            <span>{renderContent(bullet[1])}</span>
                          </div>
                        )
                      }
                      return (
                        <div key={li} style={{ minHeight: line.trim() ? undefined : '0.5em' }}>
                          {renderContent(line)}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  msg.content
                )}
              </div>
            ))}
            {loading && (
              <div className="chat-bubble chat-bubble-bot" style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                <span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2, borderTopColor: 'var(--accent)' }} />
                <span style={{ fontSize: '0.82rem' }}>Thinking…</span>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          <div className="chatbot-input-row">
            <input
              className="input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSend() }
              }}
              placeholder={placeholder || 'Type a message…'}
              disabled={loading}
              style={{ flex: 1, borderRadius: 'var(--radius-lg)' }}
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => { void handleSend() }}
              disabled={loading || !input.trim()}
              style={{ flexShrink: 0 }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
            </button>
          </div>
        </div>
      )}
      <button type="button" className="chatbot-fab" onClick={handleOpen} title={title}>
        {open ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        )}
      </button>
    </>
  )
}
