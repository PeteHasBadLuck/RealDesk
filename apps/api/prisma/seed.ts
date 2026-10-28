import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log("Skipping seed: set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD.");
    return;
  }
  if (password.length < 14) throw new Error("SEED_ADMIN_PASSWORD must be at least 14 characters.");
  const company = await prisma.company.upsert({
    where: { id: "demo-company" },
    update: {},
    create: { id: "demo-company", name: process.env.SEED_COMPANY_NAME || "Demo Company" }
  });
  await prisma.user.upsert({
    where: { companyId_email: { companyId: company.id, email: email.toLowerCase() } },
    update: {},
    create: {
      companyId: company.id,
      email: email.toLowerCase(),
      name: "Company Administrator",
      passwordHash: await bcrypt.hash(password, 12),
      role: "OWNER"
    }
  });
  console.log("Development administrator seeded.");
}
main().finally(() => prisma.$disconnect());