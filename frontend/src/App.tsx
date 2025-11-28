import { useState, useEffect } from 'react'
import './App.css'

function App() {
  const [message, setMessage] = useState<string>('')
  const [status, setStatus] = useState<string>('Loading...')

  useEffect(() => {
    // Fetch from backend API
    fetch('/api')
      .then(res => res.json())
      .then(data => {
        setMessage(data.message)
        setStatus('Connected')
      })
      .catch(err => {
        console.error('Error fetching from backend:', err)
        setStatus('Error connecting to backend')
      })
  }, [])

  return (
    <div className="App">
      <header className="App-header">
        <h1>🐝 Buzzalicious</h1>
        <p className="status">Backend Status: {status}</p>
        {message && <p className="message">{message}</p>}
      </header>
    </div>
  )
}

export default App
