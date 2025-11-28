import { useState, useEffect } from 'react';
import './AIGenerator.css';

interface AIProvider {
  id: string;
  name: string;
  supports: string[];
}

interface AIResponse {
  provider: string;
  contentType: string;
  content: string | string[];
  model?: string;
}

interface SocialAccount {
  id: string;
  platform: string;
  accountName: string;
  isActive: boolean;
}

interface GenerationRequest {
  id: string;
  provider: string;
  prompt: string;
  response: string;
  contentType: string;
  createdAt: string;
}

export function AIGenerator() {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [contentType, setContentType] = useState('text');
  const [prompt, setPrompt] = useState('');
  const [context, setContext] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<AIResponse | null>(null);
  const [error, setError] = useState('');
  const [twitterAccounts, setTwitterAccounts] = useState<SocialAccount[]>([]);
  const [selectedTwitterAccount, setSelectedTwitterAccount] = useState('');
  const [postingToTwitter, setPostingToTwitter] = useState(false);
  const [tweetSuccess, setTweetSuccess] = useState('');
  const [recentRequests, setRecentRequests] = useState<GenerationRequest[]>([]);

  useEffect(() => {
    const backendUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    
    // Fetch available providers
    fetch(`${backendUrl}/api/ai/providers`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        // Sort providers alphabetically by name
        const sortedProviders = [...data.providers].sort((a, b) => 
          a.name.localeCompare(b.name)
        );
        setProviders(sortedProviders);
        if (sortedProviders.length > 0) {
          setSelectedProvider(sortedProviders[0].id);
        }
      })
      .catch(err => {
        console.error('Error fetching providers:', err);
      });

    // Fetch Twitter accounts
    fetch(`${backendUrl}/api/profile/social-accounts`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        const twitter = data.socialAccounts.filter((acc: SocialAccount) => 
          acc.platform === 'twitter' && acc.isActive
        );
        setTwitterAccounts(twitter);
        if (twitter.length > 0) {
          setSelectedTwitterAccount(twitter[0].id);
        }
      })
      .catch(err => {
        console.error('Error fetching Twitter accounts:', err);
      });

    // Fetch recent generation requests
    fetchRecentRequests();
  }, []);

  const fetchRecentRequests = async () => {
    try {
      const backendUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const res = await fetch(`${backendUrl}/api/ai/recent`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setRecentRequests(data.requests);
      }
    } catch (err) {
      console.error('Error fetching recent requests:', err);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!prompt.trim()) {
      setError('Please enter a prompt');
      return;
    }

    setLoading(true);
    setError('');
    setResponse(null);

    try {
      const backendUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const res = await fetch(`${backendUrl}/api/ai/generate`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider,
          contentType,
          prompt,
          context: context || undefined,
          options: {
            temperature: 0.7,
          }
        })
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to generate content');
      }

      const data = await res.json();
      setResponse(data);
      // Refresh recent requests after generating new content
      fetchRecentRequests();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handlePostToTwitter = async () => {
    if (!response || response.contentType !== 'text' || typeof response.content !== 'string') {
      setError('Only text content can be posted to Twitter');
      return;
    }

    if (!selectedTwitterAccount) {
      setError('Please select a Twitter account in your Profile page');
      return;
    }

    setPostingToTwitter(true);
    setError('');
    setTweetSuccess('');

    try {
      const backendUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const res = await fetch(`${backendUrl}/api/social/twitter/post`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: selectedTwitterAccount,
          text: response.content,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to post tweet');
      }

      const data = await res.json();
      setTweetSuccess(`Tweet posted successfully! Tweet ID: ${data.tweet.id}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPostingToTwitter(false);
    }
  };

  const selectedProviderData = providers.find(p => p.id === selectedProvider);

  return (
    <div className="ai-generator-container">
      <div className="ai-generator">
        <h2>🤖 AI Content Generator</h2>
      
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>AI Provider</label>
          <div className="radio-group radio-group-horizontal">
            {providers.length === 0 && <p className="no-providers">No providers configured</p>}
            {providers.map(provider => (
              <label key={provider.id} className="radio-label">
                <input
                  type="radio"
                  name="provider"
                  value={provider.id}
                  checked={selectedProvider === provider.id}
                  onChange={(e) => setSelectedProvider(e.target.value)}
                />
                <span>{provider.name}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>Content Type</label>
          <div className="radio-group radio-group-horizontal">
            {selectedProviderData?.supports.includes('text') && (
              <label className="radio-label">
                <input
                  type="radio"
                  name="contentType"
                  value="text"
                  checked={contentType === 'text'}
                  onChange={(e) => setContentType(e.target.value)}
                />
                <span>Text</span>
              </label>
            )}
            {selectedProviderData?.supports.includes('image') && (
              <label className="radio-label">
                <input
                  type="radio"
                  name="contentType"
                  value="image"
                  checked={contentType === 'image'}
                  onChange={(e) => setContentType(e.target.value)}
                />
                <span>Image</span>
              </label>
            )}
            {selectedProviderData?.supports.includes('video') && (
              <label className="radio-label">
                <input
                  type="radio"
                  name="contentType"
                  value="video"
                  checked={contentType === 'video'}
                  onChange={(e) => setContentType(e.target.value)}
                />
                <span>Video</span>
              </label>
            )}
          </div>
        </div>

        <div className="form-group">
          <label htmlFor="context">Context (Optional)</label>
          <textarea
            id="context"
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Provide context or instructions for the AI..."
            rows={3}
          />
        </div>

        <div className="form-group">
          <label htmlFor="prompt">Prompt</label>
          <textarea
            id="prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Enter your prompt here..."
            rows={5}
            required
          />
        </div>

        <button 
          type="submit" 
          className="generate-button"
          disabled={loading || !selectedProvider}
        >
          {loading ? 'Generating...' : 'Generate'}
        </button>
      </form>

      {error && (
        <div className="error-message">
          ❌ {error}
        </div>
      )}

      {response && (
        <div className="response-container">
          <h3>Response</h3>
          <div className="response-meta">
            <span className="badge">{response.provider}</span>
            {response.model && <span className="badge">{response.model}</span>}
            <span className="badge">{response.contentType}</span>
          </div>
          
          {response.contentType === 'text' && typeof response.content === 'string' && (
            <>
              <div className="response-text">
                {response.content}
              </div>
              
              {twitterAccounts.length > 0 && (
                <div className="twitter-post-section">
                  <div className="twitter-post-header">
                    <label htmlFor="twitter-account">Post to Twitter:</label>
                    <select
                      id="twitter-account"
                      value={selectedTwitterAccount}
                      onChange={(e) => setSelectedTwitterAccount(e.target.value)}
                      disabled={postingToTwitter}
                    >
                      {twitterAccounts.map(account => (
                        <option key={account.id} value={account.id}>
                          @{account.accountName}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    className="twitter-post-button"
                    onClick={handlePostToTwitter}
                    disabled={postingToTwitter}
                  >
                    {postingToTwitter ? '🐦 Posting...' : '🐦 Post to Twitter'}
                  </button>
                  {tweetSuccess && (
                    <div className="tweet-success">
                      ✅ {tweetSuccess}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {response.contentType === 'image' && Array.isArray(response.content) && (
            <div className="response-images">
              {response.content.map((url, idx) => (
                <img key={idx} src={url} alt={`Generated ${idx + 1}`} />
              ))}
            </div>
          )}

          {response.contentType === 'video' && Array.isArray(response.content) && (
            <div className="response-videos">
              {response.content.map((url, idx) => (
                <video key={idx} src={url} controls />
              ))}
            </div>
          )}
        </div>
      )}
      </div>

      <div className="recent-requests-panel">
        <h3>📝 Recent Requests</h3>
        {recentRequests.length === 0 ? (
          <p className="no-requests">No recent requests yet</p>
        ) : (
          <div className="requests-list">
            {recentRequests.map((req) => (
              <div key={req.id} className="request-item" onClick={() => {
                setPrompt(req.prompt);
                setSelectedProvider(req.provider);
                setContentType(req.contentType);
              }}>
                <div className="request-header">
                  <span className="request-badge">{req.provider}</span>
                  <span className="request-badge">{req.contentType}</span>
                </div>
                <div className="request-prompt">{req.prompt.substring(0, 100)}{req.prompt.length > 100 ? '...' : ''}</div>
                <div className="request-date">{new Date(req.createdAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
