import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../api/supabaseClient'
import toast from 'react-hot-toast'

/**
 * Automatically logs out the user after a period of inactivity.
 * @param {number} timeoutMinutes - Minutes of inactivity before forced logout (default 15)
 * @param {number} warningMinutes  - Minutes before timeout to show a warning (default 1)
 */
export function useSessionTimeout(timeoutMinutes = 15, warningMinutes = 1) {
  const navigate = useNavigate()
  const [showWarning, setShowWarning] = useState(false)
  const warningTimeoutRef = useRef(null)
  const logoutTimeoutRef = useRef(null)
  const warningGivenRef = useRef(false)

  const clearTimers = () => {
    if (warningTimeoutRef.current) clearTimeout(warningTimeoutRef.current)
    if (logoutTimeoutRef.current) clearTimeout(logoutTimeoutRef.current)
    warningGivenRef.current = false
    setShowWarning(false)
  }

  const resetTimer = () => {
    clearTimers()

    // Set warning timer
    const warningTime = (timeoutMinutes - warningMinutes) * 60 * 1000
    if (warningTime > 0) {
      warningTimeoutRef.current = setTimeout(() => {
        setShowWarning(true)
        warningGivenRef.current = true
      }, warningTime)
    }

    // Set logout timer
    const logoutTime = timeoutMinutes * 60 * 1000
    logoutTimeoutRef.current = setTimeout(async () => {
      // Force logout
      await supabase.auth.signOut()
      localStorage.clear()
      try {
        const db = (await import('../db/localDatabase')).default
        await db.delete()
      } catch (e) {
        // Ignore
      }
      toast.error('Logged out due to inactivity')
      navigate('/login')
    }, logoutTime)
  }

  useEffect(() => {
    // Events that indicate user activity
    const events = ['mousedown', 'keydown', 'mousemove', 'touchstart', 'scroll']

    const handleActivity = () => {
      resetTimer()
    }

    // Start the timer
    resetTimer()

    // Listen for activity
    events.forEach(event => {
      document.addEventListener(event, handleActivity, { passive: true })
    })

    return () => {
      clearTimers()
      events.forEach(event => {
        document.removeEventListener(event, handleActivity)
      })
    }
  }, [timeoutMinutes, warningMinutes])

  return { showWarning, resetTimer }
}
