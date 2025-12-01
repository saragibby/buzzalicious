import { useState, useEffect } from 'react';
import './ScheduledPosts.css';
import { getBackendUrl } from '../utils/api';

interface ScheduledPost {
  id: string;
  content: string;
  platform: string;
  scheduledFor: string;
  status: string;
  twitterPostId?: string;
  twitterPostedAt?: string;
  twitterError?: string;
  linkedinPostId?: string;
  linkedinPostedAt?: string;
  linkedinError?: string;
  createdAt: string;
}

export function ScheduledPosts() {
  const [posts, setPosts] = useState<ScheduledPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'pending' | 'posted' | 'failed' | 'cancelled'>('all');

  useEffect(() => {
    fetchScheduledPosts();
  }, [filter]);

  const fetchScheduledPosts = async () => {
    try {
      setLoading(true);
      const backendUrl = getBackendUrl();
      const url = filter === 'all' 
        ? `${backendUrl}/api/schedule`
        : `${backendUrl}/api/schedule?status=${filter}`;
      
      const res = await fetch(url, {
        credentials: 'include',
      });

      if (!res.ok) throw new Error('Failed to fetch scheduled posts');

      const data = await res.json();
      setPosts(data.scheduledPosts);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = async (postId: string) => {
    if (!confirm('Are you sure you want to cancel this scheduled post?')) {
      return;
    }

    try {
      const backendUrl = getBackendUrl();
      const res = await fetch(`${backendUrl}/api/schedule/${postId}`, {
        method: 'DELETE',
        credentials: 'include',
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to cancel post');
      }

      fetchScheduledPosts();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'pending': return 'status-pending';
      case 'posted': return 'status-posted';
      case 'failed': return 'status-failed';
      case 'cancelled': return 'status-cancelled';
      default: return '';
    }
  };

  const getPlatformIcon = (platform: string) => {
    switch (platform) {
      case 'twitter': return '🐦';
      case 'linkedin': return '💼';
      case 'both': return '🐦💼';
      default: return '📱';
    }
  };

  if (loading) {
    return (
      <div className="scheduled-posts-container">
        <p>Loading scheduled posts...</p>
      </div>
    );
  }

  return (
    <div className="scheduled-posts-container">
      <div className="scheduled-header">
        <h2>📅 Scheduled Posts</h2>
        <p className="scheduled-subtitle">Manage your upcoming social media posts</p>
      </div>

      <div className="filter-tabs">
        <button 
          className={`filter-tab ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All
        </button>
        <button 
          className={`filter-tab ${filter === 'pending' ? 'active' : ''}`}
          onClick={() => setFilter('pending')}
        >
          Pending
        </button>
        <button 
          className={`filter-tab ${filter === 'posted' ? 'active' : ''}`}
          onClick={() => setFilter('posted')}
        >
          Posted
        </button>
        <button 
          className={`filter-tab ${filter === 'failed' ? 'active' : ''}`}
          onClick={() => setFilter('failed')}
        >
          Failed
        </button>
        <button 
          className={`filter-tab ${filter === 'cancelled' ? 'active' : ''}`}
          onClick={() => setFilter('cancelled')}
        >
          Cancelled
        </button>
      </div>

      {error && (
        <div className="error-message">
          ❌ {error}
        </div>
      )}

      {posts.length === 0 ? (
        <div className="no-posts">
          <p>No scheduled posts found</p>
        </div>
      ) : (
        <div className="posts-grid">
          {posts.map((post) => (
            <div key={post.id} className="post-card">
              <div className="post-header">
                <span className="platform-icon">{getPlatformIcon(post.platform)}</span>
                <span className={`status-badge ${getStatusBadgeClass(post.status)}`}>
                  {post.status}
                </span>
              </div>

              <div className="post-content">
                {post.content.length > 200 
                  ? `${post.content.substring(0, 200)}...` 
                  : post.content}
              </div>

              <div className="post-meta">
                <div className="meta-row">
                  <span className="meta-label">Scheduled for:</span>
                  <span className="meta-value">
                    {new Date(post.scheduledFor).toLocaleString()}
                  </span>
                </div>

                {post.status === 'posted' && (
                  <>
                    {post.twitterPostedAt && (
                      <div className="meta-row">
                        <span className="meta-label">🐦 Posted:</span>
                        <span className="meta-value">
                          {new Date(post.twitterPostedAt).toLocaleString()}
                        </span>
                      </div>
                    )}
                    {post.linkedinPostedAt && (
                      <div className="meta-row">
                        <span className="meta-label">💼 Posted:</span>
                        <span className="meta-value">
                          {new Date(post.linkedinPostedAt).toLocaleString()}
                        </span>
                      </div>
                    )}
                  </>
                )}

                {post.status === 'failed' && (
                  <>
                    {post.twitterError && (
                      <div className="error-row">
                        <span className="meta-label">🐦 Error:</span>
                        <span className="error-text">{post.twitterError}</span>
                      </div>
                    )}
                    {post.linkedinError && (
                      <div className="error-row">
                        <span className="meta-label">💼 Error:</span>
                        <span className="error-text">{post.linkedinError}</span>
                      </div>
                    )}
                  </>
                )}
              </div>

              {post.status === 'pending' && (
                <button 
                  className="cancel-button"
                  onClick={() => handleCancel(post.id)}
                >
                  Cancel Post
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
