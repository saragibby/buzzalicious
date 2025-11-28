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

export function AIGenerator() {
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [contentType, setContentType] = useState('text');
  const [prompt, setPrompt] = useState('');
  const [context, setContext] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<AIResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    // Fetch available providers
    const backendUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
    fetch(`${backendUrl}/api/ai/providers`, { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        setProviders(data.providers);
        if (data.providers.length > 0) {
          setSelectedProvider(data.providers[0].id);
        }
      })
      .catch(err => {
        console.error('Error fetching providers:', err);
      });
  }, []);

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
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const selectedProviderData = providers.find(p => p.id === selectedProvider);

  return (
    <div className="ai-generator">
      <h2>🤖 AI Content Generator</h2>
      
      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="provider">AI Provider</label>
          <select 
            id="provider"
            value={selectedProvider} 
            onChange={(e) => setSelectedProvider(e.target.value)}
            disabled={providers.length === 0}
          >
            {providers.length === 0 && <option>No providers configured</option>}
            {providers.map(provider => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="contentType">Content Type</label>
          <select 
            id="contentType"
            value={contentType} 
            onChange={(e) => setContentType(e.target.value)}
            disabled={!selectedProviderData}
          >
            {selectedProviderData?.supports.includes('text') && (
              <option value="text">Text</option>
            )}
            {selectedProviderData?.supports.includes('image') && (
              <option value="image">Image</option>
            )}
            {selectedProviderData?.supports.includes('video') && (
              <option value="video">Video</option>
            )}
          </select>
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
            <div className="response-text">
              {response.content}
            </div>
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
  );
}
