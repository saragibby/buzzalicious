## AI Integration

Buzzalicious supports multiple AI providers for generating text, images, and video content.

### Supported Providers

| Provider | Text | Images | Video |
|----------|------|--------|-------|
| OpenAI | ✅ | ✅ | ❌ |
| Azure OpenAI | ✅ | ✅ | ❌ |
| Google Gemini | ✅ | ❌ | ❌ |

### Setup AI Providers

**1. OpenAI**
- Get API key from [OpenAI Platform](https://platform.openai.com/)
- Add to `.env`: `OPENAI_API_KEY=your-key`

**2. Azure OpenAI**
- Create Azure OpenAI resource
- Deploy a model (e.g., gpt-4)
- Add to `.env`:
  ```
  AZURE_OPENAI_API_KEY=your-key
  AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
  AZURE_OPENAI_DEPLOYMENT=gpt-4
  ```

**3. Google Gemini**
- Get API key from [Google AI Studio](https://makersuite.google.com/app/apikey)
- Add to `.env`: `GEMINI_API_KEY=your-key`

### Using the AI API

**Check available providers:**
```bash
GET /api/ai/providers
```

**Generate content:**
```bash
POST /api/ai/generate
Content-Type: application/json

{
  "provider": "openai",           // "openai", "azure-openai", or "gemini"
  "contentType": "text",          // "text", "image", or "video"
  "prompt": "Write a story about...",
  "context": "You are a creative writer...",  // Optional
  "options": {                    // Optional
    "model": "gpt-4-turbo-preview",
    "temperature": 0.7,
    "maxTokens": 1000,
    "size": "1024x1024",          // For images
    "quality": "hd"               // For images
  }
}
```

**Example responses:**

Text generation:
```json
{
  "provider": "openai",
  "contentType": "text",
  "content": "Generated text content...",
  "model": "gpt-4-turbo-preview"
}
```

Image generation:
```json
{
  "provider": "openai",
  "contentType": "image",
  "content": ["https://oaidalleapiprodscus.blob.core.windows.net/..."],
  "model": "dall-e-3"
}
```

### Frontend Integration Example

```typescript
async function generateContent() {
  const response = await fetch('http://localhost:3001/api/ai/generate', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'openai',
      contentType: 'text',
      prompt: 'Write a haiku about coding',
      options: { temperature: 0.8 }
    })
  });
  
  const result = await response.json();
  console.log(result.content);
}
```
