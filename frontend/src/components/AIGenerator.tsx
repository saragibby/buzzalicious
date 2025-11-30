import { useState, useEffect } from 'react';
import './AIGenerator.css';
import { getBackendUrl } from '../utils/api';

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

interface GenerationRequest {
  id: string;
  provider: string;
  prompt: string;
  response: string;
  contentType: string;
  createdAt: string;
  postedToTwitter: boolean;
  twitterPostId?: string;
  postedToLinkedIn: boolean;
  linkedinPostId?: string;
  canvaDesignId?: string;
  canvaDesignUrl?: string;
}

interface TwitterStatus {
  isConnected: boolean;
  username: string | null;
}

interface LinkedInStatus {
  isConnected: boolean;
  username: string | null;
}

interface CanvaStatus {
  isConnected: boolean;
  userId: string | null;
}

interface CanvaTemplate {
  id: string;
  name: string;
  thumbnail?: string;
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
  const [twitterStatus, setTwitterStatus] = useState<TwitterStatus>({ isConnected: false, username: null });
  const [postingToTwitter, setPostingToTwitter] = useState(false);
  const [tweetSuccess, setTweetSuccess] = useState('');
  const [linkedinStatus, setLinkedinStatus] = useState<LinkedInStatus>({ isConnected: false, username: null });
  const [postingToLinkedIn, setPostingToLinkedIn] = useState(false);
  const [linkedInSuccess, setLinkedInSuccess] = useState('');
  const [canvaStatus, setCanvaStatus] = useState<CanvaStatus>({ isConnected: false, userId: null });
  const [canvaTemplates, setCanvaTemplates] = useState<CanvaTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [creatingDesign, setCreatingDesign] = useState(false);
  const [canvaSuccess, setCanvaSuccess] = useState('');
  const [showTemplateSelector, setShowTemplateSelector] = useState(false);
  const [recentRequests, setRecentRequests] = useState<GenerationRequest[]>([]);
  const [currentRequestId, setCurrentRequestId] = useState<string | null>(null);

  useEffect(() => {
    const backendUrl = getBackendUrl();
    
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

    // Fetch Twitter authorization status
    fetch(`${backendUrl}/api/social/twitter/status`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        setTwitterStatus(data);
      })
      .catch(err => {
        console.error('Error fetching Twitter status:', err);
      });

    // Fetch LinkedIn authorization status
    fetch(`${backendUrl}/api/social/linkedin/status`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        setLinkedinStatus(data);
      })
      .catch(err => {
        console.error('Error fetching LinkedIn status:', err);
      });

    // Fetch Canva authorization status
    fetch(`${backendUrl}/api/social/canva/status`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        setCanvaStatus(data);
        // If connected, fetch templates
        if (data.isConnected) {
          fetchCanvaTemplates();
        }
      })
      .catch(err => {
        console.error('Error fetching Canva status:', err);
      });

    // Fetch recent generation requests
    fetchRecentRequests();
  }, []);

  const fetchRecentRequests = async () => {
    try {
      const backendUrl = getBackendUrl();
      const res = await fetch(`${backendUrl}/api/ai/recent`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setRecentRequests(data.requests);
      }
    } catch (err) {
      console.error('Error fetching recent requests:', err);
    }
  };

  const fetchCanvaTemplates = async () => {
    try {
      const backendUrl = getBackendUrl();
      const res = await fetch(`${backendUrl}/api/social/canva/templates`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setCanvaTemplates(data.templates || []);
        if (data.templates && data.templates.length > 0) {
          setSelectedTemplate(data.templates[0].id);
        }
      }
    } catch (err) {
      console.error('Error fetching Canva templates:', err);
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
      const backendUrl = getBackendUrl();
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
      setCurrentRequestId(data.requestId || null);
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

    if (!twitterStatus.isConnected) {
      setError('Please authorize Twitter in your Profile page first');
      return;
    }

    setPostingToTwitter(true);
    setError('');
    setTweetSuccess('');

    try {
      const backendUrl = getBackendUrl();
      const res = await fetch(`${backendUrl}/api/social/twitter/post`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: response.content,
          generationRequestId: currentRequestId,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to post tweet');
      }

      const data = await res.json();
      setTweetSuccess(data.message || 'Tweet posted successfully!');
      // Refresh recent requests to show updated posted status
      fetchRecentRequests();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPostingToTwitter(false);
    }
  };

  const handlePostToLinkedIn = async () => {
    if (!response || response.contentType !== 'text' || typeof response.content !== 'string') {
      setError('Only text content can be posted to LinkedIn');
      return;
    }

    if (!linkedinStatus.isConnected) {
      setError('Please authorize LinkedIn in your Profile page first');
      return;
    }

    setPostingToLinkedIn(true);
    setError('');
    setLinkedInSuccess('');

    try {
      const backendUrl = getBackendUrl();
      const res = await fetch(`${backendUrl}/api/social/linkedin/post`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: response.content,
          generationRequestId: currentRequestId,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to post to LinkedIn');
      }

      const data = await res.json();
      setLinkedInSuccess(data.message || 'Posted to LinkedIn successfully!');
      // Refresh recent requests to show updated posted status
      fetchRecentRequests();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPostingToLinkedIn(false);
    }
  };

  const handleCreateCanvaDesign = async () => {
    if (!response || response.contentType !== 'text' || typeof response.content !== 'string') {
      setError('Only text content can be used to create Canva designs');
      return;
    }

    if (!canvaStatus.isConnected) {
      setError('Please authorize Canva in your Profile page first');
      return;
    }

    if (!selectedTemplate) {
      setError('Please select a Canva template');
      return;
    }

    setCreatingDesign(true);
    setError('');
    setCanvaSuccess('');

    try {
      const backendUrl = getBackendUrl();
      const res = await fetch(`${backendUrl}/api/social/canva/create-design`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: response.content,
          title: 'AI Generated Design',
          brandTemplateId: selectedTemplate,
          generationRequestId: currentRequestId,
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to create Canva design');
      }

      const data = await res.json();
      setCanvaSuccess(`Design created successfully! <a href="${data.design.url}" target="_blank" rel="noopener noreferrer">Open in Canva</a>`);
      setShowTemplateSelector(false);
      // Refresh recent requests to show updated Canva design status
      fetchRecentRequests();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreatingDesign(false);
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
              
              {twitterStatus.isConnected && (
                <div className="twitter-post-section">
                  <p className="twitter-account-info">
                    Posting as: <strong>@{twitterStatus.username}</strong>
                  </p>
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

              {linkedinStatus.isConnected && (
                <div className="linkedin-post-section">
                  <p className="linkedin-account-info">
                    Posting as: <strong>{linkedinStatus.username}</strong>
                  </p>
                  <button
                    className="linkedin-post-button"
                    onClick={handlePostToLinkedIn}
                    disabled={postingToLinkedIn}
                  >
                    {postingToLinkedIn ? '💼 Posting...' : '💼 Post to LinkedIn'}
                  </button>
                  {linkedInSuccess && (
                    <div className="linkedin-success">
                      ✅ {linkedInSuccess}
                    </div>
                  )}
                </div>
              )}

              {canvaStatus.isConnected && (
                <div className="canva-design-section">
                  {!showTemplateSelector ? (
                    <button
                      className="canva-create-button"
                      onClick={() => setShowTemplateSelector(true)}
                    >
                      🎨 Create Canva Design
                    </button>
                  ) : (
                    <div className="canva-template-selector">
                      <p className="canva-info">Select a template to create your design:</p>
                      <select
                        value={selectedTemplate}
                        onChange={(e) => setSelectedTemplate(e.target.value)}
                        className="template-select"
                      >
                        {canvaTemplates.length === 0 ? (
                          <option value="">No templates available</option>
                        ) : (
                          canvaTemplates.map((template) => (
                            <option key={template.id} value={template.id}>
                              {template.name}
                            </option>
                          ))
                        )}
                      </select>
                      <div className="canva-buttons">
                        <button
                          className="canva-confirm-button"
                          onClick={handleCreateCanvaDesign}
                          disabled={creatingDesign || !selectedTemplate}
                        >
                          {creatingDesign ? '🎨 Creating...' : '🎨 Create Design'}
                        </button>
                        <button
                          className="canva-cancel-button"
                          onClick={() => setShowTemplateSelector(false)}
                          disabled={creatingDesign}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {canvaSuccess && (
                    <div className="canva-success" dangerouslySetInnerHTML={{ __html: canvaSuccess }} />
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
                setCurrentRequestId(req.id);
              }}>
                <div className="request-header">
                  <span className="request-badge">{req.provider}</span>
                  <span className="request-badge">{req.contentType}</span>
                  {req.postedToTwitter && (
                    <span className="request-badge posted">🐦 Posted</span>
                  )}
                  {req.postedToLinkedIn && (
                    <span className="request-badge posted">💼 Posted</span>
                  )}
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
