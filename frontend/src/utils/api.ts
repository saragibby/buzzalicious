// Helper function to get the backend API URL
export const getBackendUrl = (): string => {
  // In production (when VITE_API_URL is not set), use the same origin as the frontend
  // This works because both frontend and backend are served from the same Heroku domain
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  
  // Check if we're in development (localhost or 127.0.0.1)
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://127.0.0.1:3001';
  }
  
  // Production: use the same origin (works when frontend and backend are on same domain)
  return window.location.origin;
};
