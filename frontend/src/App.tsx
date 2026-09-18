import { useEffect, useState } from 'react'
import logo from './logo.png'
import { getBackendUrl } from './utils/api'

interface User {
  id: string
  email: string
  name: string | null
  picture: string | null
}

/**
 * Placeholder shell. Replaced by the React Router + TanStack Query shell in W1 step 5.
 */
function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`${getBackendUrl()}/auth/me`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p>Loading…</p>

  return (
    <main>
      <img src={logo} alt="Buzzalicious" width={64} />
      <h1>Buzzalicious</h1>
      {user ? (
        <p>Signed in as {user.name ?? user.email}</p>
      ) : (
        <a href={`${getBackendUrl()}/auth/google`}>Sign in with Google</a>
      )}
    </main>
  )
}

export default App
