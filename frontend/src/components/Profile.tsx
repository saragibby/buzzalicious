import { useState, useEffect } from 'react';
import './Profile.css';

interface SocialAccount {
  id: string;
  platform: string;
  accountName: string;
  isActive: boolean;
  createdAt: string;
}

const PLATFORMS = [
  { id: 'twitter', name: 'Twitter/X', icon: '𝕏' },
  { id: 'facebook', name: 'Facebook', icon: '📘' },
  { id: 'instagram', name: 'Instagram', icon: '📷' },
  { id: 'linkedin', name: 'LinkedIn', icon: '💼' },
  { id: 'tiktok', name: 'TikTok', icon: '🎵' },
  { id: 'youtube', name: 'YouTube', icon: '▶️' },
  { id: 'threads', name: 'Threads', icon: '🧵' },
  { id: 'bluesky', name: 'Bluesky', icon: '🦋' },
];

export function Profile() {
  const [socialAccounts, setSocialAccounts] = useState<SocialAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState('');
  const [accountName, setAccountName] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const backendUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

  useEffect(() => {
    fetchSocialAccounts();
    
    // Check if Twitter was just connected (from OAuth callback)
    const params = new URLSearchParams(window.location.search);
    if (params.get('twitter_connected') === 'true') {
      setSuccess('Twitter account connected successfully!');
      fetchSocialAccounts();
      // Clean up URL
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const fetchSocialAccounts = async () => {
    try {
      const res = await fetch(`${backendUrl}/api/profile/social-accounts`, {
        credentials: 'include',
      });
      
      if (!res.ok) throw new Error('Failed to fetch accounts');
      
      const data = await res.json();
      setSocialAccounts(data.socialAccounts);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleAddAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (!selectedPlatform || !accountName.trim()) {
      setError('Please select a platform and enter an account name');
      return;
    }

    try {
      const res = await fetch(`${backendUrl}/api/profile/social-accounts`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: selectedPlatform,
          accountName: accountName.trim(),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to add account');
      }

      setSuccess('Account added successfully!');
      setSelectedPlatform('');
      setAccountName('');
      setShowAddForm(false);
      fetchSocialAccounts();
    } catch (err: any) {
      setError(err.message);
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

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    try {
      const res = await fetch(`${backendUrl}/api/profile/social-accounts/${id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !currentStatus }),
      });

      if (!res.ok) throw new Error('Failed to update account');

      fetchSocialAccounts();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDeleteAccount = async (id: string) => {
    if (!confirm('Are you sure you want to remove this account?')) return;

    try {
      const res = await fetch(`${backendUrl}/api/profile/social-accounts/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) throw new Error('Failed to delete account');

      setSuccess('Account removed successfully!');
      fetchSocialAccounts();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const getPlatformInfo = (platformId: string) => {
    return PLATFORMS.find(p => p.id === platformId) || { name: platformId, icon: '📱' };
  };

  if (loading) {
    return <div className="profile-container"><p>Loading...</p></div>;
  }

  return (
    <div className="profile-container">
      <div className="profile-header">
        <h2>👤 Profile & Connected Accounts</h2>
        <p className="profile-subtitle">Connect your social media accounts to schedule posts</p>
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
          <h3>Connected Accounts</h3>
          <div className="header-actions">
            <button 
              className="connect-twitter-button"
              onClick={handleConnectTwitter}
            >
              🐦 Connect Twitter
            </button>
            <button 
              className="add-account-button"
              onClick={() => setShowAddForm(!showAddForm)}
            >
              {showAddForm ? '✕ Cancel' : '+ Add Other'}
            </button>
          </div>
        </div>

        {showAddForm && (
          <form className="add-account-form" onSubmit={handleAddAccount}>
            <div className="form-row">
              <select
                value={selectedPlatform}
                onChange={(e) => setSelectedPlatform(e.target.value)}
                required
              >
                <option value="">Select platform...</option>
                {PLATFORMS.map(platform => (
                  <option key={platform.id} value={platform.id}>
                    {platform.icon} {platform.name}
                  </option>
                ))}
              </select>

              <input
                type="text"
                placeholder="Account name or handle"
                value={accountName}
                onChange={(e) => setAccountName(e.target.value)}
                required
              />

              <button type="submit" className="submit-button">
                Add
              </button>
            </div>
          </form>
        )}

        {socialAccounts.length === 0 ? (
          <div className="no-accounts">
            <p>No social accounts connected yet.</p>
            <p>Click "Add Account" to get started!</p>
          </div>
        ) : (
          <div className="accounts-grid">
            {socialAccounts.map(account => {
              const platformInfo = getPlatformInfo(account.platform);
              return (
                <div key={account.id} className={`account-card ${!account.isActive ? 'inactive' : ''}`}>
                  <div className="account-header">
                    <span className="platform-icon">{platformInfo.icon}</span>
                    <div className="account-info">
                      <h4>{platformInfo.name}</h4>
                      <p>@{account.accountName}</p>
                    </div>
                    <div className="account-status">
                      <span className={`status-badge ${account.isActive ? 'active' : 'inactive'}`}>
                        {account.isActive ? '✓ Active' : '○ Inactive'}
                      </span>
                    </div>
                  </div>
                  <div className="account-actions">
                    <button
                      className="toggle-button"
                      onClick={() => handleToggleActive(account.id, account.isActive)}
                    >
                      {account.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      className="delete-button"
                      onClick={() => handleDeleteAccount(account.id)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
