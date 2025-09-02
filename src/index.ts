  import { Hono } from 'hono'
  import { PrismaClient } from '@prisma/client/edge'
  import { withAccelerate } from '@prisma/extension-accelerate'
  import { GoogleGenerativeAI } from '@google/generative-ai'

  // Worker bindings
  type Bindings = {
    DATABASE_URL: string
    GEMINI_API_KEY: string
  }

  const app = new Hono<{ Bindings: Bindings }>()

  // Prisma helper
  const getPrisma = (c: any) =>
    new PrismaClient({
      datasourceUrl: c.env.DATABASE_URL,
    }).$extends(withAccelerate())

  // -------------------------
  // Reddit Fetcher
  // -------------------------
  app.get('/fetch', async (c) => {
    const prisma = getPrisma(c)
    

    const subreddits = ['acquiresaas', 'microacquisitions', 'saasforsale']  
    const limit = 10
    const newPosts: string[] = []

    for (const sub of subreddits) {
      const url = `https://www.reddit.com/r/${sub}/top.json?t=day&limit=${limit}`
      const res = await fetch(url, { headers: { 'User-Agent': 'deal-worker' } })

      if (!res.ok) continue
      const json = await res.json<any>()
      const posts = json?.data?.children || []

      for (const { data } of posts) {
        // Skip posts without selftext
        if (!data.selftext || data.selftext.trim() === '') continue

        const exists = await prisma.deal.findUnique({
          where: { redditId: data.id },
        })

        if (!exists) {
          await prisma.rawDeal.create({
        data: {
          redditId: data.id,
          title: data.title,
          url: `https://reddit.com${data.permalink}`,
          score: data.score ?? 0,
          subreddit: sub,
          selftext: data.selftext,
          images: [], // (optional: extract images if needed)
        },
          })
          newPosts.push(data.id)
        }
      }
        }

    return c.json({ message: 'Fetched posts', newPosts })
  })

  // -------------------------
  // AI Processor
  // -------------------------
  const withRetry = async (fn: () => Promise<Response>, maxRetries = 3): Promise<Response> => {
    let lastError: Error | null = null;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        const result = await fn();
        if (result.ok) return result;
        
        // If it's a rate limit error, wait and retry
        if (result.status === 429) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
          continue;
        }
        
        return result; // Return non-429 errors immediately
      } catch (error) {
        lastError = error as Error;
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
      }
    }
    
    throw lastError || new Error('Max retries exceeded');
  };

  const processPostWithGemini = async (
    post: any,
    env: Bindings
  ): Promise<any | null> => {
    const prompt = `
Analyze the following Reddit post to extract key business details.

If the post is a listing for a sale or acquisition, set 'isSale' to true. Otherwise, set it to false.

If the post is missing a clear description, revenue figures, an asking price, and a user count, set 'lowQuality' to true. Otherwise, set it to false.

For links, if there are multiple URLs mentioned in the content, return them as an array. If there's only one or none, return as a string.

Extract the following information and format it as a single JSON object.

Post Title: ${post.title}
Post Content: ${post.selftext ?? ''}
    `;

    const payload = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            isSale: { "type": "BOOLEAN" },
            lowQuality: { "type": "BOOLEAN" },
            professionalSummary: { "type": "STRING" },
            monthlyRevenue: { "type": "STRING" },
            askingPrice: { "type": "STRING" },
            userCount: { "type": "STRING" },
            link: { "type": "ARRAY", "items": { "type": "STRING" } },
            otherImportantStuff: { "type": "STRING" }
          },
          "propertyOrdering": [
            "isSale",
            "lowQuality",
            "professionalSummary",
            "monthlyRevenue",
            "askingPrice",
            "userCount",
            "link",
            "otherImportantStuff"
          ]
        }
      }
    };

    try {
      const response = await withRetry(() => fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }
      ));

      if (!response.ok) {
        console.error(`Gemini API request failed with status: ${response.status}`);
        const errorText = await response.text();
        console.error('Error response:', errorText);
        return null;
      }

      const result = await response.json() as any;
      const jsonText = result?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!jsonText) {
        console.error('Gemini API response is missing content part:', JSON.stringify(result));
        return null;
      }

      return JSON.parse(jsonText);
    } catch (error) {
      console.error('Error during Gemini API call:', error);
      return null;
    }
  };

  // -------------------------
  // Processor Endpoint
  // -------------------------
  const fetchRedditPosts = async (env: Bindings) => {
    const prisma = new PrismaClient({
      datasourceUrl: env.DATABASE_URL,
    }).$extends(withAccelerate())

    const subreddits = ['acquiresaas', 'microacquisitions', 'saasforsale']  
    const limit = 10
    const newPosts: string[] = []

    for (const sub of subreddits) {
      const url = `https://www.reddit.com/r/${sub}/top.json?t=day&limit=${limit}`
      const res = await fetch(url, { headers: { 'User-Agent': 'deal-worker' } })

      if (!res.ok) continue
      const json = await res.json<any>()
      const posts = json?.data?.children || []

      for (const { data } of posts) {
        // Skip posts without selftext
        if (!data.selftext || data.selftext.trim() === '') continue

        const exists = await prisma.rawDeal.findUnique({
          where: { redditId: data.id },
        })

        if (!exists) {
          await prisma.rawDeal.create({
            data: {
              redditId: data.id,
              title: data.title,
              url: `https://reddit.com${data.permalink}`,
              score: data.score ?? 0,
              subreddit: sub,
              selftext: data.selftext,
              images: [],
            },
          })
          newPosts.push(data.id)
        }
      }
    }

    console.log(`Cron job: Fetched ${newPosts.length} new posts`)
    return newPosts
  }

  const processDeals = async (env: Bindings, batchSize: number = 2) => {
    const prisma = new PrismaClient({
      datasourceUrl: env.DATABASE_URL,
    }).$extends(withAccelerate())

    // Early exit if no unprocessed deals
    const unprocessedCount = await prisma.rawDeal.count({
      where: { processed: false }
    })

    if (unprocessedCount === 0) {
      console.log('Cron job: No unprocessed deals found, exiting early')
      return {
        message: 'No unprocessed deals found',
        summary: { totalProcessed: 0, successfullySaved: 0, skipped: 0 },
        processedDeals: [],
        skippedDeals: []
      }
    }

    const raws = await prisma.rawDeal.findMany({
      where: { processed: false },
      take: batchSize,
    })

    const processedIds: string[] = []
    const processedData: any[] = []
    const skippedDeals: any[] = []

    for (const raw of raws) {
      const aiResult = await processPostWithGemini(raw, env)

      // Check if AI processing was successful and required fields are not null/empty
      if (aiResult && 
          aiResult !== "unknown error" && 
          aiResult.isSale !== undefined &&
          aiResult.professionalSummary && 
          aiResult.professionalSummary.trim() !== '' &&
          aiResult.otherImportantStuff && 
          aiResult.otherImportantStuff.trim() !== '') {
        
        const dealData = {
          redditId: raw.redditId,
          originalTitle: raw.title,
          url: raw.url,
          score: raw.score,
          subreddit: raw.subreddit,
          images: raw.images,
          isSale: aiResult.isSale ?? false,
          lowQuality: aiResult.lowQuality ?? false,
          professionalSummary: aiResult.professionalSummary,
          monthlyRevenue: aiResult.monthlyRevenue,
          askingPrice: aiResult.askingPrice,
          userCount: aiResult.userCount,
          link: aiResult.link ?? [],
          otherImportantStuff: aiResult.otherImportantStuff,
        }

        await prisma.deal.create({
          data: dealData,
        })

        await prisma.rawDeal.update({
          where: { redditId: raw.redditId },
          data: { processed: true }
        })

        processedIds.push(raw.redditId)
        processedData.push({
          redditId: raw.redditId,
          title: raw.title,
          aiProcessedData: aiResult
        })
      } else {
        // Skip deal and mark as processed but don't save to deals table
        await prisma.rawDeal.update({
          where: { redditId: raw.redditId },
          data: { processed: true }
        })

        skippedDeals.push({
          redditId: raw.redditId,
          title: raw.title,
          reason: !aiResult ? 'AI processing failed' : 
                  !aiResult.professionalSummary || aiResult.professionalSummary.trim() === '' ? 'Missing professional summary' :
                  !aiResult.otherImportantStuff || aiResult.otherImportantStuff.trim() === '' ? 'Missing other important stuff' :
                  'Invalid AI result',
          aiResult: aiResult
        })
      }
    }

    console.log(`Cron job: Processed ${processedIds.length}/${raws.length} deals successfully`)
    return {
      message: 'Processing batch completed',
      summary: {
        totalProcessed: raws.length,
        successfullySaved: processedIds.length,
        skipped: skippedDeals.length
      },
      processedDeals: processedData,
      skippedDeals: skippedDeals
    }
  }

  app.get('/process', async (c) => {
    const prisma = getPrisma(c)

    // Early exit check
    const unprocessedCount = await prisma.rawDeal.count({
      where: { processed: false }
    })

    if (unprocessedCount === 0) {
      return c.json({ 
        message: 'No unprocessed deals found.',
        summary: { totalProcessed: 0, successfullySaved: 0, skipped: 0 },
        processedDeals: [],
        skippedDeals: []
      })
    }

    const raws = await prisma.rawDeal.findMany({
      where: { processed: false },
      take: 3,
    })
    console.log(`Found ${raws.length} unprocessed deals`);

    const processedIds: string[] = []
    const processedData: any[] = []
    const skippedDeals: any[] = []

    for (const raw of raws) {
      const aiResult = await processPostWithGemini(raw, c.env)
      console.log('AI Result for', raw.redditId, ':', aiResult);

      // Check if AI processing was successful and required fields are not null/empty
      if (aiResult && 
          aiResult !== "unknown error" && 
          aiResult.isSale !== undefined &&
          aiResult.professionalSummary && 
          aiResult.professionalSummary.trim() !== '' &&
          aiResult.otherImportantStuff && 
          aiResult.otherImportantStuff.trim() !== '') {
        
        const dealData = {
          redditId: raw.redditId,
          originalTitle: raw.title,
          url: raw.url,
          score: raw.score,
          subreddit: raw.subreddit,
          images: raw.images,
          isSale: aiResult.isSale ?? false,
          lowQuality: aiResult.lowQuality ?? false,
          professionalSummary: aiResult.professionalSummary,
          monthlyRevenue: aiResult.monthlyRevenue,
          askingPrice: aiResult.askingPrice,
          userCount: aiResult.userCount,
          link: aiResult.link ?? [],
          otherImportantStuff: aiResult.otherImportantStuff,
        }

        await prisma.deal.create({
          data: dealData,
        })

        await prisma.rawDeal.update({
          where: { redditId: raw.redditId },
          data: { processed: true }
        })

        processedIds.push(raw.redditId)
        processedData.push({
          redditId: raw.redditId,
          title: raw.title,
          aiProcessedData: aiResult
        })
      } else {
        // Skip deal and mark as processed but don't save to deals table
        await prisma.rawDeal.update({
          where: { redditId: raw.redditId },
          data: { processed: true }
        })

        skippedDeals.push({
          redditId: raw.redditId,
          title: raw.title,
          reason: !aiResult ? 'AI processing failed' : 
                  !aiResult.professionalSummary || aiResult.professionalSummary.trim() === '' ? 'Missing professional summary' :
                  !aiResult.otherImportantStuff || aiResult.otherImportantStuff.trim() === '' ? 'Missing other important stuff' :
                  'Invalid AI result',
          aiResult: aiResult
        })
      }
    }

    return c.json({ 
      message: 'Processing batch completed',
      summary: {
        totalProcessed: raws.length,
        successfullySaved: processedIds.length,
        skipped: skippedDeals.length
      },
      processedDeals: processedData,
      skippedDeals: skippedDeals
    })
  })

  // -------------------------
  // Embedding Functions
  // -------------------------
  function generateEmbeddingText(deal: {
    originalTitle: string;
    professionalSummary?: string | null;
    otherImportantStuff?: string | null;
    monthlyRevenue?: string | null;
    askingPrice?: string | null;
    userCount?: string | null;
  }): string {
    const parts: string[] = [deal.originalTitle];

    if (deal.professionalSummary) {
      parts.push(deal.professionalSummary);
    }
    if (deal.otherImportantStuff) {
      parts.push(deal.otherImportantStuff);
    }
    if (deal.monthlyRevenue) {
      parts.push(`Monthly Revenue: ${deal.monthlyRevenue}`);
    }
    if (deal.askingPrice) {
      parts.push(`Asking Price: ${deal.askingPrice}`);
    }
    if (deal.userCount) {
      parts.push(`User Count: ${deal.userCount}`);
    }

    return parts.join(" ");
  }

  const processEmbeddings = async (env: Bindings, batchSize: number = 3) => {
    const prisma = new PrismaClient({
      datasourceUrl: env.DATABASE_URL,
    }).$extends(withAccelerate())

    // Find deals without embeddings using raw SQL
   const dealsWithoutEmbeddings = await prisma.$queryRawUnsafe<{
  id: string;
  originalTitle: string;
  professionalSummary: string | null;
  otherImportantStuff: string | null;
  monthlyRevenue: string | null;
  askingPrice: string | null;
  userCount: string | null;
}[]>(`
  SELECT id, "originalTitle", "professionalSummary", "otherImportantStuff",
         "monthlyRevenue", "askingPrice", "userCount"
  FROM "deal"
  WHERE embedding IS NULL
    AND "professionalSummary" IS NOT NULL
    AND "otherImportantStuff" IS NOT NULL
`);



    if (dealsWithoutEmbeddings.length === 0) {
      console.log('No deals without embeddings found')
      return {
        message: 'No deals without embeddings found',
        processed: 0,
        failed: 0
      }
    }

    console.log(`Processing embeddings for ${dealsWithoutEmbeddings.length} deals`)

    const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY)
    const model = genAI.getGenerativeModel({ model: "embedding-001" })

    let processed = 0
    let failed = 0

    for (const deal of dealsWithoutEmbeddings) {
      try {
        const text = generateEmbeddingText(deal)
        console.log(`Generating embedding for deal ${deal.id}: ${text.substring(0, 100)}...`)

        // Generate embedding using Gemini
        const result = await model.embedContent({
          content: {
            role: "user",
            parts: [{ text }],
          },
        })

        const embedding = result.embedding.values

        // Store embedding in database using raw SQL
        await prisma.$executeRawUnsafe(
          `UPDATE "deal" SET embedding = $1 WHERE id = $2`,
          embedding,
          deal.id
        )

        console.log(`✅ Updated embedding for Deal #${deal.id}`)
        processed++
      } catch (error) {
        console.error(`❌ Failed to generate embedding for Deal #${deal.id}:`, error)
        failed++
      }
    }

    console.log(`Embedding processing completed: ${processed} processed, ${failed} failed`)
    return {
      message: 'Embedding processing completed',
      processed,
      failed,
      totalDeals: dealsWithoutEmbeddings.length
    }
  }

  app.get('/embeddings', async (c) => {
    const prisma = getPrisma(c)

    // Check if there are deals without embeddings using raw SQL
    const countResult = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*) as count 
      FROM "deal" 
      WHERE embedding IS NULL 
        AND "professionalSummary" IS NOT NULL 
        AND "otherImportantStuff" IS NOT NULL
    `

    const dealsWithoutEmbeddings = Number(countResult[0].count)

    if (dealsWithoutEmbeddings === 0) {
      return c.json({
        message: 'No deals without embeddings found',
        processed: 0,
        failed: 0,
        totalDeals: 0
      })
    }

    console.log(`Found ${dealsWithoutEmbeddings} deals without embeddings`)

    // Process embeddings
    const result = await processEmbeddings(c.env, 3)

    return c.json(result)
  })

  // -------------------------
  // Cleanup Endpoint
  // -------------------------
  const cleanupProcessedRawDeals = async (env: Bindings) => {
    const prisma = new PrismaClient({
      datasourceUrl: env.DATABASE_URL,
    }).$extends(withAccelerate())

    // Delete all processed raw deals
    const deletedCount = await prisma.rawDeal.deleteMany({
      where: { processed: true }
    })

    console.log(`Cleanup: Deleted ${deletedCount.count} processed raw deals`)
    return deletedCount.count
  }

  app.get('/cleanup', async (c) => {
    const prisma = getPrisma(c)

    // Get count before deletion for reporting
    const processedCount = await prisma.rawDeal.count({
      where: { processed: true }
    })

    if (processedCount === 0) {
      return c.json({
        message: 'No processed raw deals to clean up',
        deletedCount: 0,
        remainingRawDeals: await prisma.rawDeal.count()
      })
    }

    // Delete processed raw deals
    const result = await prisma.rawDeal.deleteMany({
      where: { processed: true }
    })

    const remainingCount = await prisma.rawDeal.count()

    return c.json({
      message: 'Cleanup completed successfully',
      deletedCount: result.count,
      remainingRawDeals: remainingCount
    })
  })

  // -------------------------
  // Export Worker
  // -------------------------
  export default {
    fetch: app.fetch,
    scheduled: async (event: any, env: any, ctx: any) => {
      const cron = event.cron
      console.log(`Scheduled event triggered: ${cron}`)

      try {
        if (cron === '0 0 * * *') {
          // Daily fetch at midnight UTC
          console.log('Running daily Reddit fetch...')
          const newPosts = await fetchRedditPosts(env)
          console.log(`Daily fetch completed: ${newPosts.length} new posts`)
        } else if (cron === '0 */2 * * *') {
          // Process every 2 hours (3 deals per run = ~36 deals per day)
          console.log('Running bi-hourly deal processing...')
          const result = await processDeals(env, 3)
          console.log(`Bi-hourly processing completed:`, result.summary)
        } else if (cron === '30 1,4,6,9,11,14,16,19,21 * * *') {
          // Process embeddings every ~2.5 hours (9 times per day)
          console.log('Running embedding processing...')
          const result = await processEmbeddings(env, 3)
          console.log(`Embedding processing completed:`, result)
        } else if (cron === '0 6,18 * * *') {
          // Cleanup processed raw deals twice a day (6 AM and 6 PM UTC)
          console.log('Running cleanup of processed raw deals...')
          const deletedCount = await cleanupProcessedRawDeals(env)
          console.log(`Cleanup completed: ${deletedCount} processed raw deals deleted`)
        }
      } catch (error) {
        console.error('Scheduled event error:', error)
      }
    }
  }
