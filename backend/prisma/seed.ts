import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting database seed...');

  // Create sample user
  const user = await prisma.user.upsert({
    where: { email: 'demo@buzzalicious.com' },
    update: {},
    create: {
      email: 'demo@buzzalicious.com',
      name: 'Demo User',
    },
  });

  console.log('✅ Created user:', user);

  // Create sample templates
  const template1 = await prisma.template.create({
    data: {
      name: 'Welcome Email',
      purpose: 'Send welcome messages to new users',
      userId: user.id,
    },
  });

  console.log('✅ Created template:', template1);

  const template2 = await prisma.template.create({
    data: {
      name: 'Newsletter',
      purpose: 'Monthly newsletter template for updates',
      userId: user.id,
    },
  });

  console.log('✅ Created template:', template2);

  console.log('🎉 Database seeded successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
