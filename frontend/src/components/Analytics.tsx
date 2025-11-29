import { useState, useEffect } from 'react';
import './Analytics.css';

interface ProviderStats {
  provider: string;
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  avgResponseTime: number;
  avgCost: number;
  avgTokens: number;
  postsCreated: number;
  modelsUsed: Record<string, number>;
}

interface AnalyticsData {
  stats: ProviderStats[];
  totalRequests: number;
  totalCost: number;
}

export function Analytics() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    try {
      const backendUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';
      const res = await fetch(`${backendUrl}/api/ai/analytics`, {
        credentials: 'include',
      });

      if (!res.ok) throw new Error('Failed to fetch analytics');

      const analyticsData = await res.json();
      setData(analyticsData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const getProviderName = (provider: string) => {
    const names: Record<string, string> = {
      'openai': 'OpenAI',
      'azure-openai': 'Azure OpenAI',
      'gemini': 'Google Gemini',
    };
    return names[provider] || provider;
  };

  const formatCost = (cost: number) => {
    return `$${cost.toFixed(4)}`;
  };

  const formatTime = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  if (loading) {
    return <div className="analytics-container"><p>Loading analytics...</p></div>;
  }

  if (error) {
    return (
      <div className="analytics-container">
        <div className="error-message">❌ {error}</div>
      </div>
    );
  }

  if (!data || data.stats.length === 0) {
    return (
      <div className="analytics-container">
        <h2>📊 AI Provider Analytics</h2>
        <div className="no-data">
          <p>No data yet. Generate some content to see analytics!</p>
        </div>
      </div>
    );
  }

  return (
    <div className="analytics-container">
      <div className="analytics-header">
        <h2>📊 AI Provider Analytics</h2>
        <div className="analytics-summary">
          <div className="summary-card">
            <span className="summary-label">Total Requests</span>
            <span className="summary-value">{data.totalRequests}</span>
          </div>
          <div className="summary-card">
            <span className="summary-label">Total Cost</span>
            <span className="summary-value">{formatCost(data.totalCost)}</span>
          </div>
        </div>
      </div>

      <div className="providers-comparison">
        <h3>Provider Comparison</h3>
        <div className="comparison-grid">
          {data.stats.map(stat => (
            <div key={stat.provider} className="provider-card">
              <div className="provider-header">
                <h4>{getProviderName(stat.provider)}</h4>
                <span className="provider-badge">{stat.totalRequests} requests</span>
              </div>

              <div className="stat-grid">
                <div className="stat-item">
                  <span className="stat-label">Avg Response Time</span>
                  <span className="stat-value">{formatTime(stat.avgResponseTime)}</span>
                </div>

                <div className="stat-item">
                  <span className="stat-label">Avg Cost per Request</span>
                  <span className="stat-value">{formatCost(stat.avgCost)}</span>
                </div>

                <div className="stat-item">
                  <span className="stat-label">Avg Tokens Used</span>
                  <span className="stat-value">{stat.avgTokens.toLocaleString()}</span>
                </div>

                <div className="stat-item">
                  <span className="stat-label">Total Cost</span>
                  <span className="stat-value highlight">{formatCost(stat.totalCost)}</span>
                </div>

                <div className="stat-item">
                  <span className="stat-label">Total Tokens</span>
                  <span className="stat-value">{stat.totalTokens.toLocaleString()}</span>
                </div>

                <div className="stat-item">
                  <span className="stat-label">Posts Created</span>
                  <span className="stat-value">{stat.postsCreated}</span>
                </div>
              </div>

              {Object.keys(stat.modelsUsed).length > 0 && (
                <div className="models-used">
                  <span className="models-label">Models:</span>
                  <div className="models-list">
                    {Object.entries(stat.modelsUsed).map(([model, count]) => (
                      <span key={model} className="model-tag">
                        {model} ({count})
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="insights-section">
        <h3>💡 Insights</h3>
        <div className="insights-grid">
          {(() => {
            const fastest = data.stats.reduce((min, stat) => 
              stat.avgResponseTime < min.avgResponseTime ? stat : min
            );
            const cheapest = data.stats.reduce((min, stat) => 
              stat.avgCost < min.avgCost ? stat : min
            );
            const mostUsed = data.stats.reduce((max, stat) => 
              stat.totalRequests > max.totalRequests ? stat : max
            );

            return (
              <>
                <div className="insight-card fastest">
                  <span className="insight-icon">⚡</span>
                  <div className="insight-content">
                    <span className="insight-label">Fastest</span>
                    <span className="insight-value">{getProviderName(fastest.provider)}</span>
                    <span className="insight-detail">{formatTime(fastest.avgResponseTime)} avg</span>
                  </div>
                </div>

                <div className="insight-card cheapest">
                  <span className="insight-icon">💰</span>
                  <div className="insight-content">
                    <span className="insight-label">Most Cost-Effective</span>
                    <span className="insight-value">{getProviderName(cheapest.provider)}</span>
                    <span className="insight-detail">{formatCost(cheapest.avgCost)} per request</span>
                  </div>
                </div>

                <div className="insight-card most-used">
                  <span className="insight-icon">⭐</span>
                  <div className="insight-content">
                    <span className="insight-label">Most Used</span>
                    <span className="insight-value">{getProviderName(mostUsed.provider)}</span>
                    <span className="insight-detail">{mostUsed.totalRequests} requests</span>
                  </div>
                </div>
              </>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
