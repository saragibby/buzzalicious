import { Router, Request, Response } from 'express';
import { isAuthenticated } from '../middleware/auth';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

// Schedule a post
router.post('/', isAuthenticated, async (req: Request, res: Response): Promise<void> => {
  try {
    const { content, platform, scheduledFor, generationRequestId } = req.body;
    const userId = (req.user as any)?.id;

    // Validation
    if (!content || !platform || !scheduledFor) {
      res.status(400).json({ error: 'Missing required fields: content, platform, scheduledFor' });
      return;
    }

    if (!['twitter', 'linkedin', 'both'].includes(platform)) {
      res.status(400).json({ error: 'Invalid platform. Must be twitter, linkedin, or both' });
      return;
    }

    const scheduledDate = new Date(scheduledFor);
    if (scheduledDate <= new Date()) {
      res.status(400).json({ error: 'Scheduled time must be in the future' });
      return;
    }

    const scheduledPost = await prisma.scheduledPost.create({
      data: {
        userId,
        content,
        platform,
        scheduledFor: scheduledDate,
        generationRequestId,
      },
    });

    res.json({ success: true, scheduledPost });
  } catch (error: any) {
    console.error('Schedule post error:', error);
    res.status(500).json({ error: error.message || 'Failed to schedule post' });
  }
});

// Get user's scheduled posts
router.get('/', isAuthenticated, async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)?.id;
    const { status } = req.query;

    const where: any = { userId };
    if (status) {
      where.status = status;
    }

    const scheduledPosts = await prisma.scheduledPost.findMany({
      where,
      orderBy: { scheduledFor: 'asc' },
    });

    res.json({ scheduledPosts });
  } catch (error: any) {
    console.error('Get scheduled posts error:', error);
    res.status(500).json({ error: error.message || 'Failed to get scheduled posts' });
  }
});

// Cancel a scheduled post
router.delete('/:id', isAuthenticated, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = (req.user as any)?.id;

    const scheduledPost = await prisma.scheduledPost.findFirst({
      where: { id, userId },
    });

    if (!scheduledPost) {
      res.status(404).json({ error: 'Scheduled post not found' });
      return;
    }

    if (scheduledPost.status === 'posted') {
      res.status(400).json({ error: 'Cannot cancel a post that has already been posted' });
      return;
    }

    await prisma.scheduledPost.update({
      where: { id },
      data: { status: 'cancelled' },
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('Cancel scheduled post error:', error);
    res.status(500).json({ error: error.message || 'Failed to cancel scheduled post' });
  }
});

// Update scheduled post time
router.patch('/:id', isAuthenticated, async (req: Request, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const { scheduledFor } = req.body;
    const userId = (req.user as any)?.id;

    const scheduledPost = await prisma.scheduledPost.findFirst({
      where: { id, userId },
    });

    if (!scheduledPost) {
      res.status(404).json({ error: 'Scheduled post not found' });
      return;
    }

    if (scheduledPost.status !== 'pending') {
      res.status(400).json({ error: 'Can only reschedule pending posts' });
      return;
    }

    const newScheduledDate = new Date(scheduledFor);
    if (newScheduledDate <= new Date()) {
      res.status(400).json({ error: 'Scheduled time must be in the future' });
      return;
    }

    const updatedPost = await prisma.scheduledPost.update({
      where: { id },
      data: { scheduledFor: newScheduledDate },
    });

    res.json({ success: true, scheduledPost: updatedPost });
  } catch (error: any) {
    console.error('Update scheduled post error:', error);
    res.status(500).json({ error: error.message || 'Failed to update scheduled post' });
  }
});

export default router;
