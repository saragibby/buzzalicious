import { Router, Request, Response } from 'express';
import prisma from '../db';

const router = Router();

// Get user's social accounts
router.get('/social-accounts', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const socialAccounts = await prisma.socialAccount.findMany({
      where: { userId: (req.user as any).id },
      select: {
        id: true,
        platform: true,
        accountName: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ socialAccounts });
  } catch (error) {
    console.error('Error fetching social accounts:', error);
    res.status(500).json({ error: 'Failed to fetch social accounts' });
  }
});

// Add a social account
router.post('/social-accounts', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { platform, accountName } = req.body;

    if (!platform || !accountName) {
      res.status(400).json({ error: 'Platform and account name are required' });
      return;
    }

    // Check if account already exists
    const existing = await prisma.socialAccount.findFirst({
      where: {
        userId: (req.user as any).id,
        platform,
        accountName,
      },
    });

    if (existing) {
      res.status(400).json({ error: 'This account is already connected' });
      return;
    }

    const socialAccount = await prisma.socialAccount.create({
      data: {
        userId: (req.user as any).id,
        platform,
        accountName,
      },
      select: {
        id: true,
        platform: true,
        accountName: true,
        isActive: true,
        createdAt: true,
      },
    });

    res.json({ socialAccount });
  } catch (error) {
    console.error('Error adding social account:', error);
    res.status(500).json({ error: 'Failed to add social account' });
  }
});

// Update social account
router.patch('/social-accounts/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;
    const { accountName, isActive } = req.body;

    // Verify ownership
    const account = await prisma.socialAccount.findFirst({
      where: {
        id,
        userId: (req.user as any).id,
      },
    });

    if (!account) {
      res.status(404).json({ error: 'Social account not found' });
      return;
    }

    const updated = await prisma.socialAccount.update({
      where: { id },
      data: {
        ...(accountName && { accountName }),
        ...(isActive !== undefined && { isActive }),
      },
      select: {
        id: true,
        platform: true,
        accountName: true,
        isActive: true,
        createdAt: true,
      },
    });

    res.json({ socialAccount: updated });
  } catch (error) {
    console.error('Error updating social account:', error);
    res.status(500).json({ error: 'Failed to update social account' });
  }
});

// Delete social account
router.delete('/social-accounts/:id', async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { id } = req.params;

    // Verify ownership
    const account = await prisma.socialAccount.findFirst({
      where: {
        id,
        userId: (req.user as any).id,
      },
    });

    if (!account) {
      res.status(404).json({ error: 'Social account not found' });
      return;
    }

    await prisma.socialAccount.delete({
      where: { id },
    });

    res.json({ message: 'Social account deleted successfully' });
  } catch (error) {
    console.error('Error deleting social account:', error);
    res.status(500).json({ error: 'Failed to delete social account' });
  }
});

export default router;
