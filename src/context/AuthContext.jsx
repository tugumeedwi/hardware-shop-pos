import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../api/supabaseClient'

const AuthContext = createContext()

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      if (session) fetchProfile(session.user.id)
      else setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      if (session) fetchProfile(session.user.id)
      else { setProfile(null); setLoading(false); }
    })

    return () => listener?.subscription.unsubscribe()
  }, [])

  async function fetchProfile(userId) {
    // Try online first
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single()

      if (error) throw error
      if (data) {
        setProfile(data)
        // Cache profile for offline use
        localStorage.setItem('cachedProfile', JSON.stringify(data))
        setLoading(false)
        return
      }
    } catch (onlineError) {
      console.warn('Online profile fetch failed, trying cache:', onlineError.message)
    }

    // Fallback to cached profile
    const cached = localStorage.getItem('cachedProfile')
    if (cached) {
      setProfile(JSON.parse(cached))
      setLoading(false)
    } else {
      // No profile at all – force re‑login
      setProfile(null)
      setLoading(false)
    }
  }

  const value = { session, profile, loading }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)
