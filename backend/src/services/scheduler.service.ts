import { PrismaClient } from '@prisma/client';
import { TwitterService } from './twitter.service';
import { LinkedInService } from './linkedin.service';

const prisma = new PrismaClient();

export class SchedulerService {
  // Process all pending scheduled posts that are due
  static async processDuePosts(): Promise<void> {
    try {
      const now = new Date();
      
      // Find all pending posts that are due
      const duePosts = await prisma.scheduledPost.findMany({
        where: {
          status: 'pending',
          scheduledFor: {
            lte: now,
          },
        },
        include: {
          user: true,
        },
      });

      console.log(`Found ${duePosts.length} posts to process`);

      for (const post of duePosts) {
        await this.processPost(post);
      }
    } catch (error) {
      console.error('Error processing scheduled posts:', error);
    }
  }

  // Process a single scheduled post
  private static async processPost(post: any): Promise<void> {
    const { id, content, platform, user } = post;
    let twitterSuccess = false;
    let linkedinSuccess = false;
    let twitterError: string | null = null;
    let linkedinError: string | null = null;
    let twitterPostId: string | null = null;
    let linkedinPostId: string | null = null;

    console.log(`Processing scheduled post ${id} for user ${user.email}`);

    // Post to Twitter
    if (platform === 'twitter' || platform === 'both') {
      if (user.twitterAccessToken && user.twitterAccessSecret) {
        try {
          const twitterService = new TwitterService(
            user.twitterAccessToken,
            user.twitterAccessSecret
          );
          const result = await twitterService.postTweet(content);
          twitterPostId = result.id;
          twitterSuccess = true;
          console.log(`Successfully posted to Twitter: ${twitterPostId}`);
        } catch (error: any) {
          twitterError = error.message;
          console.error(`Failed to post to Twitter:`, error);
        }
      } else {
        twitterError = 'Twitter not authorized';
      }
    }

    // Post to LinkedIn
    if (platform === 'linkedin' || platform === 'both') {
      if (user.linkedinAccessToken) {
        try {
          // Check if token is expired
          if (user.linkedinTokenExpiry && new Date(user.linkedinTokenExpiry) <= new Date()) {
            throw new Error('LinkedIn token expired');
          }

          const linkedinService = new LinkedInService(user.linkedinAccessToken);
          const result = await linkedinService.postText(content);
          linkedinPostId = result.id;
          linkedinSuccess = true;
          console.log(`Successfully posted to LinkedIn: ${linkedinPostId}`);
        } catch (error: any) {
          linkedinError = error.message;
          console.error(`Failed to post to LinkedIn:`, error);
        }
      } else {
        linkedinError = 'LinkedIn not authorized';
      }
    }

    // Determine overall status
    let status = 'failed';
    if (platform === 'twitter' && twitterSuccess) {
      status = 'posted';
    } else if (platform === 'linkedin' && linkedinSuccess) {
      status = 'posted';
    } else if (platform === 'both' && (twitterSuccess || linkedinSuccess)) {
      status = 'posted';
    }

    // Update the scheduled post
    await prisma.scheduledPost.update({
      where: { id },
      data: {
        status,
        twitterPostId,
        twitterPostedAt: twitterSuccess ? new Date() : null,
        twitterError,
        linkedinPostId,
        linkedinPostedAt: linkedinSuccess ? new Date() : null,
        linkedinError,
      },
    });

    // Update the generation request if it exists
    if (post.generationRequestId) {
      const updateData: any = {};
      
      if (twitterSuccess) {
        updateData.postedToTwitter = true;
        updateData.twitterPostId = twitterPostId;
        updateData.twitterPostedAt = new Date();
      }
      
      if (linkedinSuccess) {
        updateData.postedToLinkedIn = true;
        updateData.linkedinPostId = linkedinPostId;
        updateData.linkedinPostedAt = new Date();
      }

      if (Object.keys(updateData).length > 0) {
        await prisma.generationRequest.update({
          where: { id: post.generationRequestId },
          data: updateData,
        });
      }
    }

    console.log(`Completed processing post ${id} with status: ${status}`);
  }

  // Start the scheduler (runs every minute)
  static startScheduler(): NodeJS.Timeout {
    console.log('Starting post scheduler...');
    
    // Run immediately on startup
    this.processDuePosts();
    
    // Then run every minute
    return setInterval(() => {
      this.processDuePosts();
    }, 60 * 1000); // 60 seconds
  }
}
