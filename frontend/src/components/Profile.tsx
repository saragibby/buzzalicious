import { useState, useEffect } from 'react';
import './Profile.css';

interface TwitterStatus {
  isConnected: boolean;
  username: string | null;
  userId: string | null;
}

interface LinkedInStatus {
  isConnected: boolean;
  username: string | null;
  userId: string | null;
}

interface CanvaStatus {
  isConnected: boolean;
  userId: string | null;
}

export function Profile() {
  const [twitterStatus, setTwitterStatus] = useState<TwitterStatus>({ isConnected: false, username: null, userId: null });
  const [linkedinStatus, setLinkedinStatus] = useState<LinkedInStatus>({ isConnected: false, username: null, userId: null });
  const [canvaStatus, setCanvaStatus] = useState<CanvaStatus>({ isConnected: false, userId: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const backendUrl = import.meta.env.VITE_API_URL || 'http://127.0.0.1:3001';

  useEffect(() => {
    fetchTwitterStatus();
    fetchLinkedInStatus();
    fetchCanvaStatus();
    
    // Check if Twitter was just connected (from OAuth callback)
    const params = new URLSearchParams(window.location.search);
    if (params.get('twitter_connected') === 'true') {
      setSuccess('Twitter account connected successfully!');
      fetchTwitterStatus();
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (params.get('linkedin_connected') === 'true') {
      setSuccess('LinkedIn account connected successfully!');
      fetchLinkedInStatus();
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (params.get('canva_connected') === 'true') {
      setSuccess('Canva account connected successfully!');
      fetchCanvaStatus();
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const fetchTwitterStatus = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/social/twitter/status`, {
        credentials: 'include',
      });
      
      if (!res.ok) throw new Error('Failed to fetch Twitter status');
      
      const data = await res.json();
      setTwitterStatus(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchLinkedInStatus = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/social/linkedin/status`, {
        credentials: 'include',
      });
      
      if (!res.ok) throw new Error('Failed to fetch LinkedIn status');
      
      const data = await res.json();
      setLinkedinStatus(data);
    } catch (err: any) {
      console.error('LinkedIn status error:', err.message);
    }
  };

  const fetchCanvaStatus = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/social/canva/status`, {
        credentials: 'include',
      });
      
      if (!res.ok) throw new Error('Failed to fetch Canva status');
      
      const data = await res.json();
      setCanvaStatus(data);
    } catch (err: any) {
      console.error('Canva status error:', err.message);
    }
  };

  const handleConnectTwitter = async () => {
    setError('');
    try {
      const res = await fetch(`${backendUrl}/api/social/twitter/connect`, {
        credentials: 'include',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.details || data.error || 'Failed to initiate Twitter connection');
      }

      const data = await res.json();
      // Redirect to Twitter OAuth
      window.location.href = data.authUrl;
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleConnectLinkedIn = async () => {
    setError('');
    try {
      const res = await fetch(`${backendUrl}/api/social/linkedin/connect`, {
        credentials: 'include',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.details || data.error || 'Failed to initiate LinkedIn connection');
      }

      const data = await res.json();
      // Redirect to LinkedIn OAuth
      window.location.href = data.authUrl;
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleConnectCanva = async () => {
    setError('');
    try {
      console.log('Fetching Canva connect URL...');
      const res = await fetch(`${backendUrl}/api/social/canva/connect`, {
        credentials: 'include',
      });

      console.log('Canva connect response status:', res.status);

      if (!res.ok) {
        const data = await res.json();
        console.error('Canva connect error:', data);
        throw new Error(data.details || data.error || 'Failed to initiate Canva connection');
      }

      const data = await res.json();
      console.log('Received auth URL:', data.authUrl);
      
      // Redirect to Canva OAuth
      window.location.href = data.authUrl;
    } catch (err: any) {
      console.error('Canva connection error:', err);
      setError(err.message);
    }
  };

  const handleDisconnectTwitter = async () => {
    setError('');
    setSuccess('');
    try {
      const res = await fetch(`${backendUrl}/api/social/twitter/disconnect`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!res.ok) throw new Error('Failed to disconnect Twitter');

      setSuccess('Twitter account disconnected successfully');
      fetchTwitterStatus();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDisconnectLinkedIn = async () => {
    setError('');
    setSuccess('');
    try {
      const res = await fetch(`${backendUrl}/api/social/linkedin/disconnect`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!res.ok) throw new Error('Failed to disconnect LinkedIn');

      setSuccess('LinkedIn account disconnected successfully');
      fetchLinkedInStatus();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDisconnectCanva = async () => {
    setError('');
    setSuccess('');
    try {
      const res = await fetch(`${backendUrl}/api/social/canva/disconnect`, {
        method: 'POST',
        credentials: 'include',
      });

      if (!res.ok) throw new Error('Failed to disconnect Canva');

      setSuccess('Canva account disconnected successfully');
      fetchCanvaStatus();
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (loading) {
    return <div className="profile-container"><p>Loading...</p></div>;
  }

  return (
    <div className="profile-container">
      <div className="profile-header">
        <h2>👤 Profile & Authorization</h2>
        <p className="profile-subtitle">Authorize Buzzalicious to post on your behalf</p>
      </div>

      {error && (
        <div className="message error-message">
          ❌ {error}
        </div>
      )}

      {success && (
        <div className="message success-message">
          ✅ {success}
        </div>
      )}

      <div className="social-accounts-section">
        <div className="section-header">
          <h3>Social Media Authorization</h3>
        </div>

        <div className="platform-card twitter-card">
          <div className="platform-header">
            <span className="platform-icon">𝕏</span>
            <div className="platform-info">
              <h4>Twitter / X</h4>
              <p className="platform-description">
                Allow Buzzalicious to post tweets on your behalf
              </p>
            </div>
          </div>

          {twitterStatus.isConnected ? (
            <div className="authorization-status connected">
              <div className="status-info">
                <span className="status-badge active">✓ Authorized</span>
                <p className="connected-account">@{twitterStatus.username}</p>
              </div>
              <p className="status-note">
                You can now post AI-generated content directly to Twitter from the AI Generator
              </p>
              <button 
                className="disconnect-button"
                onClick={handleDisconnectTwitter}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="authorization-status not-connected">
              <p className="status-note">
                Connect your Twitter account to enable posting generated content
              </p>
              <button 
                className="connect-button twitter-connect"
                onClick={handleConnectTwitter}
              >
                🐦 Authorize Twitter
              </button>
            </div>
          )}
        </div>

        <div className="platform-card linkedin-card">
          <div className="platform-header">
            <span className="platform-icon">💼</span>
            <div className="platform-info">
              <h4>LinkedIn</h4>
              <p className="platform-description">
                Allow Buzzalicious to post on LinkedIn on your behalf
              </p>
            </div>
          </div>

          {linkedinStatus.isConnected ? (
            <div className="authorization-status connected">
              <div className="status-info">
                <span className="status-badge active">✓ Authorized</span>
                <p className="connected-account">{linkedinStatus.username}</p>
              </div>
              <p className="status-note">
                You can now post AI-generated content directly to LinkedIn from the AI Generator
              </p>
              <button 
                className="disconnect-button"
                onClick={handleDisconnectLinkedIn}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="authorization-status not-connected">
              <p className="status-note">
                Connect your LinkedIn account to enable posting generated content
              </p>
              <button 
                className="connect-button linkedin-connect"
                onClick={handleConnectLinkedIn}
              >
                💼 Authorize LinkedIn
              </button>
            </div>
          )}
        </div>

        <div className="platform-card canva-card">
          <div className="platform-header">
            <span className="platform-icon">🎨</span>
            <div className="platform-info">
              <h4>Canva</h4>
              <p className="platform-description">
                Create beautiful designs from AI-generated content
              </p>
            </div>
          </div>

          {canvaStatus.isConnected ? (
            <div className="authorization-status connected">
              <div className="status-info">
                <span className="status-badge active">✓ Authorized</span>
              </div>
              <p className="status-note">
                You can now create Canva designs from generated text in the AI Generator
              </p>
              <button 
                className="disconnect-button"
                onClick={handleDisconnectCanva}
              >
                Disconnect
              </button>
            </div>
          ) : (
            <div className="authorization-status not-connected">
              <p className="status-note">
                Connect your Canva account to create visual designs from AI-generated content
              </p>
              <button 
                className="connect-button canva-connect"
                onClick={handleConnectCanva}
              >
                🎨 Authorize Canva
              </button>
            </div>
          )}
        </div>

        {/* Placeholder for future platforms */}
        <div className="platform-card disabled">
          <div className="platform-header">
            <span className="platform-icon">📘</span>
            <div className="platform-info">
              <h4>Facebook</h4>
              <p className="platform-description">Coming soon</p>
            </div>
          </div>
        </div>

        <div className="platform-card disabled">
          <div className="platform-header">
            <span className="platform-icon">📷</span>
            <div className="platform-info">
              <h4>Instagram</h4>
              <p className="platform-description">Coming soon</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
