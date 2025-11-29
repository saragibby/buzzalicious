import { useState, useEffect } from 'react'
import './App.css'
import { AIGenerator } from './components/AIGenerator'
import { Profile } from './components/Profile'
import { Analytics } from './components/Analytics'
import logo from './logo.png'

interface User {
  id: string;
  email: string;
  name: string | null;
  picture: string | null;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'generator' | 'profile' | 'analytics'>('generator');

  useEffect(() => {
    // Check if user is logged in
    const backendUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    fetch(`${backendUrl}/auth/me`, { credentials: 'include' })
      .then(res => {
        if (res.ok) {
          return res.json();
        }
        throw new Error('Not authenticated');
      })
      .then(data => {
        setUser(data);
      })
      .catch(() => {
        setUser(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const handleLogin = () => {
    const backendUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    window.location.href = `${backendUrl}/auth/google`;
  };

  const handleLogout = () => {
    const backendUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    fetch(`${backendUrl}/auth/logout`, { credentials: 'include' })
      .then(() => {
        setUser(null);
      });
  };

  if (loading) {
    return (
      <div className="App">
        <header className="App-header">
          <h1>🐝 Buzzalicious</h1>
          <p>Loading...</p>
        </header>
      </div>
    );
  }

  return (
    <div className="App">
      <header className="App-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <img src={logo} alt="Buzzalicious Logo" className="app-logo" style={{ width: '190px' }} />
          <h1>Buzzalicious</h1>
        </div>
        {user ? (
          <div className="user-profile">
            {user.picture && (
              <img 
                src={user.picture} 
                alt={user.name || 'User'} 
                className="user-avatar"
              />
            )}
            <p className="welcome-message">Welcome, {user.name || user.email}!</p>
            <button onClick={handleLogout} className="auth-button">
              Logout
            </button>
          </div>
        ) : (
          <div className="login-prompt">
            <p>Sign in to access your templates</p>
            <button onClick={handleLogin} className="auth-button google-button">
              <svg className="google-icon" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Sign in with Google
            </button>
          </div>
        )}
      </header>

      {user && (
        <>
          <nav className="tab-navigation">
            <button 
              className={`tab-button ${activeTab === 'generator' ? 'active' : ''}`}
              onClick={() => setActiveTab('generator')}
            >
              🤖 AI Generator
            </button>
            <button 
              className={`tab-button ${activeTab === 'analytics' ? 'active' : ''}`}
              onClick={() => setActiveTab('analytics')}
            >
              📊 Analytics
            </button>
            <button 
              className={`tab-button ${activeTab === 'profile' ? 'active' : ''}`}
              onClick={() => setActiveTab('profile')}
            >
              👤 Profile & Accounts
            </button>
          </nav>

          {activeTab === 'generator' && <AIGenerator />}
          {activeTab === 'analytics' && <Analytics />}
          {activeTab === 'profile' && <Profile />}
        </>
      )}
    </div>
  )
}

export default App
