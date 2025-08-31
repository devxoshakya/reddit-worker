# Reddit Deal Worker 🤖

An automated Cloudflare Worker that fetches Reddit posts from SaaS acquisition subreddits, processes them with AI (Google Gemini), and stores structured deal data in a PostgreSQL database.

## 🌟 Features

- **Automated Reddit Fetching**: Daily collection of posts from acquisition subreddits
- **AI Processing**: Uses Google Gemini AI to extract structured business data
- **Smart Filtering**: Only processes quality posts with meaningful content
- **Automated Cleanup**: Periodic database maintenance
- **Scheduled Operations**: Fully automated cron jobs for 24/7 operation
- **Error Handling**: Robust retry logic and error management

## 🚀 Quick Start

### Prerequisites

- [Bun](https://bun.sh/) or Node.js 18+
- Cloudflare account with Workers plan
- PostgreSQL database (recommended: [Neon](https://neon.tech/) or [Supabase](https://supabase.com/))
- Google AI Studio API key

### Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd reddit-worker

# Install dependencies
bun install

# Generate Prisma client
bunx prisma generate
```

### Environment Setup

1. Create a `.dev.vars` file for local development:
```bash
DATABASE_URL="your_database_connection_string"
GEMINI_API_KEY="your_google_ai_api_key"
```

2. Set up production environment variables in Cloudflare:
```bash
# Set production secrets (run these commands)
bunx wrangler secret put DATABASE_URL
bunx wrangler secret put GEMINI_API_KEY
```

### Database Setup

```bash
# Run database migrations
bunx prisma migrate dev --name init

# (Optional) View your data
bunx prisma studio
```

## 🛠️ Development

```bash
# Start development server
bun dev

# Deploy to Cloudflare Workers
bun run deploy

# Generate TypeScript types
bun run cf-typegen
```

## 📊 API Endpoints

### Manual Operations

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/fetch` | GET | Manually fetch new Reddit posts |
| `/process` | GET | Manually process unprocessed deals |
| `/cleanup` | GET | Manually cleanup processed raw deals |

### Example Usage

```bash
# Fetch new posts
curl https://your-worker.your-subdomain.workers.dev/fetch

# Process deals
curl https://your-worker.your-subdomain.workers.dev/process

# Cleanup database
curl https://your-worker.your-subdomain.workers.dev/cleanup
```

## ⏰ Automated Schedule

The worker runs automatically with the following cron jobs:

| Time (UTC) | Action | Description |
|------------|--------|-------------|
| `0 0 * * *` | Fetch | Daily Reddit post collection |
| `0 */2 * * *` | Process | Process 3 deals every 2 hours (~36/day) |
| `0 6,18 * * *` | Cleanup | Database cleanup twice daily |

## 🗄️ Database Schema

### Models

- **RawDeal**: Unprocessed Reddit posts
- **Deal**: AI-processed deal data with structured fields
- **User**: User management (for future features)

### Key Fields Extracted by AI

- `isSale`: Boolean indicating if post is a sale listing
- `lowQuality`: Boolean for content quality assessment
- `professionalSummary`: AI-generated business summary
- `monthlyRevenue`: Extracted revenue information
- `askingPrice`: Sale price if available
- `userCount`: Number of users/customers
- `link`: Relevant URLs from the post
- `otherImportantStuff`: Additional important details

## 🔧 Configuration

### Subreddits Monitored

- `acquiresaas`
- `microacquisitions`
- `saasforsale`

### Processing Rules

- Only processes posts with content (selftext)
- Skips deals missing professional summary or important details
- Marks all processed posts to prevent reprocessing
- Early exit when no unprocessed deals exist

## 📈 Monitoring

### Logs

Check Cloudflare Workers logs for:
- Fetch operations: `Daily fetch completed: X new posts`
- Processing results: `Bi-hourly processing completed: X/Y deals`
- Cleanup operations: `Cleanup completed: X processed raw deals deleted`

### Response Examples

#### Successful Processing
```json
{
  "message": "Processing batch completed",
  "summary": {
    "totalProcessed": 3,
    "successfullySaved": 2,
    "skipped": 1
  },
  "processedDeals": [...],
  "skippedDeals": [...]
}
```

#### Cleanup Response
```json
{
  "message": "Cleanup completed successfully",
  "deletedCount": 25,
  "remainingRawDeals": 8
}
```

## 🔐 Security

- Environment variables stored securely in Cloudflare
- No sensitive data in repository
- API keys and database URLs properly isolated
- Comprehensive `.gitignore` for security

## 🚀 Deployment

### Production Deployment

```bash
# Deploy to Cloudflare Workers
bun run deploy

# Verify deployment
curl https://your-worker.your-subdomain.workers.dev/fetch
```

### Environment Variables Setup

For production, set these secrets:

```bash
bunx wrangler secret put DATABASE_URL
# Enter your database connection string when prompted

bunx wrangler secret put GEMINI_API_KEY
# Enter your Google AI API key when prompted
```

## 🛡️ Error Handling

- **Retry Logic**: Automatic retries for API failures
- **Rate Limiting**: Built-in handling for Reddit/Gemini API limits
- **Database Errors**: Graceful handling of connection issues
- **Empty Data**: Early exit when no work is available

## 📝 Development Notes

### TypeScript Configuration

Pass the `CloudflareBindings` as generics when instantiating Hono:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

### Adding New Subreddits

Update the subreddits array in `src/index.ts`:

```ts
const subreddits = ['acquiresaas', 'microacquisitions', 'saasforsale', 'newsubreddit']
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Links

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Prisma Docs](https://www.prisma.io/docs/)
- [Hono Framework](https://hono.dev/)
- [Google AI Studio](https://aistudio.google.com/)

---

Built with ❤️ using Cloudflare Workers, Prisma, and Google Gemini AI
