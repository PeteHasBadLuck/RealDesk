import Fastify, { FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { saveEncryptedRecording, readEncryptedRecording } from "./recordings.js";

const prisma = new PrismaClient();
const app = Fastify({ logger: true, bodyLimit: 110_000_000 });
const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error("JWT_SECRET must be set to a random value of at least 32 characters.");
await app.register(cors, { origin: (process.env.CORS_ORIGIN || "http://localhost:5173").split(","), credentials: true });
await app.register(jwt, { secret: JWT_SECRET, sign: { expiresIn: "8h" } });
await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
await app.register(multipart, { limits: { fileSize: 100_000_000, files: 1 } });

type Session = { sub: string; companyId: string; role: Role; email: string; sessionVersion: number };
declare module "fastify" {
  interface FastifyRequest { session: Session }
  interface FastifyInstance { authenticate: (req: FastifyRequest, reply: any) => Promise<void> }
}
app.decorate("authenticate", async (req: FastifyRequest, reply: any) => {
  try {
    await req.jwtVerify();
    const payload = req.user as Session;
    const user = await prisma.user.findFirst({ where: { id: payload.sub, companyId: payload.companyId, active: true } });
    if (!user || payload.sessionVersion !== user.sessionVersion) return reply.code(401).send({ error: "Session is no longer valid" });
    req.session = { sub: user.id, companyId: user.companyId, role: user.role, email: user.email, sessionVersion: user.sessionVersion };
  } catch { return reply.code(401).send({ error: "Authentication required" }); }
});
const adminRoles: Role[] = ["OWNER", "ADMIN"];
const supervisorRoles: Role[] = [...adminRoles, "SUPERVISOR"];
function requireRole(req: FastifyRequest, reply: any, roles: Role[]) {
  if (!roles.includes(req.session.role)) { reply.code(403).send({ error: "Insufficient permissions" }); return false; }
  return true;
}
function audit(companyId: string, actorId: string, action: string, entity: string, entityId?: string, metadata?: object) {
  return prisma.auditLog.create({ data: { companyId, actorId, action, entity, entityId, metadata: metadata as any } });
}
const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });
app.get("/health", async () => ({ ok: true, service: "realdesk-api" }));

app.post("/api/auth/register-company", { config: { rateLimit: { max: 3, timeWindow: "1 hour" } } }, async (req, reply) => {
  const parsed = z.object({
    companyName: z.string().trim().min(2).max(160),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254),
    password: z.string().min(14).max(200)
  }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Enter a company name, your name, a valid email, and a password with at least 14 characters." });
  const email = parsed.data.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return reply.code(409).send({ error: "An account already exists for that email. Sign in or use another email." });
  try {
    const created = await prisma.$transaction(async tx => {
      const company = await tx.company.create({ data: { name: parsed.data.companyName } });
      const user = await tx.user.create({
        data: {
          companyId: company.id,
          name: parsed.data.name,
          email,
          passwordHash: await bcrypt.hash(parsed.data.password, 12),
          role: "OWNER"
        },
        select: { id: true, name: true, email: true, role: true, presence: true, sessionVersion: true, company: { select: { name: true } } }
      });
      return { company, user };
    });
    const token = app.jwt.sign({ sub: created.user.id, companyId: created.company.id, role: created.user.role, email: created.user.email, sessionVersion: created.user.sessionVersion });
    await audit(created.company.id, created.user.id, "company.registered", "Company", created.company.id);
    return reply.code(201).send({ token, user: created.user });
  } catch (error: any) {
    if (error?.code === "P2002") return reply.code(409).send({ error: "An account already exists for that email." });
    req.log.error({ err: error }, "Company registration failed");
    return reply.code(500).send({ error: "Could not create company workspace. Please retry." });
  }
});
app.post("/api/auth/login", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (req, reply) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Enter a valid email and password" });
  const email = parsed.data.email.toLowerCase();
  const candidates = await prisma.user.findMany({ where: { email, active: true }, take: 2, include: { company: true } });
  if (candidates.length !== 1 || !(await bcrypt.compare(parsed.data.password, candidates[0].passwordHash)))
    return reply.code(401).send({ error: "Invalid credentials" });
  const user = candidates[0];
  const token = app.jwt.sign({ sub: user.id, companyId: user.companyId, role: user.role, email: user.email, sessionVersion: user.sessionVersion });
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, presence: user.presence, company: { name: user.company.name } } };
});
app.get("/api/auth/me", { preHandler: [app.authenticate] }, async req => {
  const user = await prisma.user.findFirstOrThrow({ where: { id: req.session.sub, companyId: req.session.companyId }, select: { id: true, name: true, email: true, role: true, presence: true, company: { select: { name: true } } } });
  return { user };
});
app.post("/api/auth/change-password", { preHandler: [app.authenticate] }, async (req, reply) => {
  const p = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(14).max(200) }).safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: "New password must be at least 14 characters." });
  const user = await prisma.user.findFirst({ where: { id: req.session.sub, companyId: req.session.companyId, active: true } });
  if (!user || !(await bcrypt.compare(p.data.currentPassword, user.passwordHash))) return reply.code(401).send({ error: "Current password is incorrect." });
  const updated = await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(p.data.newPassword, 12), sessionVersion: { increment: 1 } } });
  await audit(req.session.companyId, req.session.sub, "auth.password_changed", "User", user.id);
  const token = app.jwt.sign({ sub: updated.id, companyId: updated.companyId, role: updated.role, email: updated.email, sessionVersion: updated.sessionVersion });
  return { ok: true, token };
});
app.post("/api/auth/logout", { preHandler: [app.authenticate] }, async (req, reply) => {
  await prisma.user.update({ where: { id: req.session.sub }, data: { sessionVersion: { increment: 1 } } });
  await audit(req.session.companyId, req.session.sub, "auth.logged_out", "User", req.session.sub);
  return { ok: true };
});

app.get("/api/users", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  const users = await prisma.user.findMany({ where: { companyId: req.session.companyId }, select: { id: true, name: true, email: true, role: true, active: true, presence: true, sipUsername: true, sipDomain: true, encryptedSipSecret: true, createdAt: true }, orderBy: { createdAt: "desc" } });
  return users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, presence: u.presence, hasSipCredentials: Boolean(u.encryptedSipSecret), sipUsername: u.sipUsername, sipDomain: u.sipDomain, createdAt: u.createdAt }));
});
app.post("/api/users", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, adminRoles)) return;
  const schema = z.object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(254),
    password: z.string().min(14).max(200),
    role: z.enum(["ADMIN", "SUPERVISOR", "AGENT"]),
    sipUsername: z.string().max(255).optional(),
    sipDomain: z.string().max(255).optional(),
    sipPassword: z.string().max(500).optional()
  });
  const p = schema.safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: "Invalid user details; passwords must be at least 14 characters." });
  let encryptedSipSecret: string | undefined;
  if (p.data.sipPassword) {
    if (!p.data.sipUsername || !p.data.sipDomain) return reply.code(400).send({ error: "SIP username and domain are required when adding an agent SIP password." });
    const secretKey = process.env.VOIP_ENCRYPTION_KEY;
    if (!secretKey || secretKey.length < 32) return reply.code(503).send({ error: "Server administrator must configure VOIP_ENCRYPTION_KEY before storing credentials." });
    const crypto = await import("node:crypto");
    const key = crypto.createHash("sha256").update(secretKey).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(p.data.sipPassword, "utf8"), cipher.final()]);
    encryptedSipSecret = [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
  }
  const user = await prisma.user.create({
    data: {
      companyId: req.session.companyId, name: p.data.name, email: p.data.email.toLowerCase(),
      passwordHash: await bcrypt.hash(p.data.password, 12), role: p.data.role,
      sipUsername: p.data.sipUsername || null, sipDomain: p.data.sipDomain || null,
      encryptedSipSecret: encryptedSipSecret || null
    },
    select: { id: true, name: true, email: true, role: true, active: true, sipUsername: true, sipDomain: true, encryptedSipSecret: true }
  }).catch(() => null);
  if (!user) return reply.code(409).send({ error: "Could not create user; email may already exist." });
  await audit(req.session.companyId, req.session.sub, "user.created", "User", user.id);
  return reply.code(201).send({ id:user.id, name:user.name, email:user.email, role:user.role, active:user.active, sipUsername:user.sipUsername, sipDomain:user.sipDomain, hasSipCredentials:Boolean(user.encryptedSipSecret) });
});
app.patch("/api/users/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, adminRoles)) return;
  const schema = z.object({
    active: z.boolean().optional(),
    role: z.enum(["ADMIN", "SUPERVISOR", "AGENT"]).optional(),
    name: z.string().min(1).max(120).optional(),
    sipUsername: z.string().max(255).optional(),
    sipDomain: z.string().max(255).optional(),
    sipPassword: z.string().max(500).optional(),
    clearSipCredentials: z.boolean().optional()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data || {}).length === 0) return reply.code(400).send({ error: "Invalid update" });
  const p = parsed.data;
  const id = (req.params as any).id;
  if (id === req.session.sub && (p.role !== undefined || p.active !== undefined)) return reply.code(400).send({ error: "Use another administrator to change your own role or active state" });
  if (p.clearSipCredentials && p.sipPassword) return reply.code(400).send({ error: "Choose either a new SIP password or clearing the SIP profile." });
  const existing = await prisma.user.findFirst({ where: { id, companyId: req.session.companyId } });
  if (!existing) return reply.code(404).send({ error: "User not found" });
  const data: any = {};
  if (p.active !== undefined) { data.active = p.active; if (!p.active) data.presence = "OFFLINE"; }
  if (p.role !== undefined) data.role = p.role;
  if (p.name !== undefined) data.name = p.name;
  let sipUpdated = false;
  if (p.clearSipCredentials) {
    data.sipUsername = null; data.sipDomain = null; data.encryptedSipSecret = null; sipUpdated = true;
  } else if (p.sipPassword) {
    const sipUsername = p.sipUsername ?? existing.sipUsername;
    const sipDomain = p.sipDomain ?? existing.sipDomain;
    if (!sipUsername || !sipDomain) return reply.code(400).send({ error: "SIP username and domain are required to set an extension password." });
    const secretKey = process.env.VOIP_ENCRYPTION_KEY;
    if (!secretKey || secretKey.length < 32) return reply.code(503).send({ error: "Server administrator must configure VOIP_ENCRYPTION_KEY before storing credentials." });
    const crypto = await import("node:crypto");
    const key = crypto.createHash("sha256").update(secretKey).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(p.sipPassword, "utf8"), cipher.final()]);
    data.sipUsername = sipUsername; data.sipDomain = sipDomain;
    data.encryptedSipSecret = [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
    sipUpdated = true;
  } else if (p.sipUsername !== undefined || p.sipDomain !== undefined) {
    const sipUsername = p.sipUsername ?? existing.sipUsername;
    const sipDomain = p.sipDomain ?? existing.sipDomain;
    if (existing.encryptedSipSecret && (!sipUsername || !sipDomain)) return reply.code(400).send({ error: "SIP username and domain cannot be blank while a dedicated password is saved." });
    if (!existing.encryptedSipSecret && (p.sipUsername || p.sipDomain)) return reply.code(400).send({ error: "Enter a SIP password too, or clear the dedicated profile to use the company login." });
    data.sipUsername = sipUsername || null; data.sipDomain = sipDomain || null; sipUpdated = true;
  }
  if (!Object.keys(data).length) return reply.code(400).send({ error: "No changes supplied" });
  await prisma.user.update({ where: { id }, data });
  await audit(req.session.companyId, req.session.sub, "user.updated", "User", id, { activeChanged: p.active !== undefined, roleChanged: p.role !== undefined, sipUpdated });
  return { ok: true };
});

app.patch("/api/agents/presence", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (req.session.role !== "AGENT") return reply.code(403).send({ error: "Only call-agent accounts can update agent presence." });
  const p = z.object({ presence: z.enum(["OFFLINE","AVAILABLE","AWAY","ON_BREAK"]) }).safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: "Choose Available, Away, On break, or Offline." });
  const updated = await prisma.user.update({ where: { id: req.session.sub }, data: { presence: p.data.presence }, select: { id: true, presence: true } });
  await audit(req.session.companyId, req.session.sub, "agent.presence_changed", "User", updated.id, { presence: updated.presence });
  return updated;
});
app.get("/api/contacts/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
  const id = (req.params as any).id;
  const contact = await prisma.contact.findFirst({
    where: {
      id,
      companyId: req.session.companyId,
      ...(req.session.role === "AGENT" ? { AND: [{ OR: [{ campaignLinks: { some: { assignedTo: req.session.sub } } }, { campaignLinks: { none: {} } }] }] } : {})
    }
  });
  if (!contact) return reply.code(404).send({ error: "Contact not found or not assigned to you" });
  return contact;
});
app.get("/api/contacts", { preHandler: [app.authenticate] }, async req => {
  const q = (req.query as any)?.q?.toString().slice(0, 100);
  const status = (req.query as any)?.status?.toString();
  const where: any = { companyId: req.session.companyId };
  const and: any[] = [];
  if (req.session.role === "AGENT") and.push({ OR: [{ campaignLinks: { some: { assignedTo: req.session.sub } } }, { campaignLinks: { none: {} } }] });
  if (status && ["NEW","CALLBACK","INTERESTED","NOT_INTERESTED","WRONG_NUMBER","DO_NOT_CALL","CONVERTED"].includes(status)) where.status = status;
  if (q) and.push({ OR: [{ firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { email: { contains: q, mode: "insensitive" } }, { companyName: { contains: q, mode: "insensitive" } }] });
  if (and.length) where.AND = and;
  return prisma.contact.findMany({ where, orderBy: { updatedAt: "desc" }, take: 500 });
});
const contactSchema = z.object({ firstName: z.string().min(1).max(100), lastName: z.string().max(100).optional().default(""), phone: z.string().min(3).max(40), email: z.string().email().max(254).optional().or(z.literal("")), companyName: z.string().max(160).optional(), status: z.enum(["NEW","CALLBACK","INTERESTED","NOT_INTERESTED","WRONG_NUMBER","DO_NOT_CALL","CONVERTED"]).optional(), notes: z.string().max(5000).optional(), doNotCall: z.boolean().optional(), callbackAt: z.string().datetime().nullable().optional() });
app.post("/api/contacts", { preHandler: [app.authenticate] }, async (req, reply) => {
  const p = contactSchema.safeParse(req.body); if (!p.success) return reply.code(400).send({ error: "Invalid contact details", details: p.error.flatten() });
  const contact = await prisma.contact.create({ data: { ...p.data, email: p.data.email || null, companyId: req.session.companyId } });
  await audit(req.session.companyId, req.session.sub, "contact.created", "Contact", contact.id);
  return reply.code(201).send(contact);
});
app.patch("/api/contacts/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
  const p = contactSchema.partial().safeParse(req.body); if (!p.success || !Object.keys(p.data || {}).length) return reply.code(400).send({ error: "Invalid contact update" });
  const id = (req.params as any).id;
  const accessible = await prisma.contact.findFirst({ where: { id, companyId: req.session.companyId, ...(req.session.role === "AGENT" ? { AND: [{ OR: [{ campaignLinks: { some: { assignedTo: req.session.sub } } }, { campaignLinks: { none: {} } }] }] } : {}) } });
  if (!accessible) return reply.code(404).send({ error: "Contact not found or not assigned to you" });
  const data: any = { ...p.data }; if (data.email === "") data.email = null;
  const result = await prisma.contact.updateMany({ where: { id, companyId: req.session.companyId }, data });
  if (!result.count) return reply.code(404).send({ error: "Contact not found" });
  await audit(req.session.companyId, req.session.sub, "contact.updated", "Contact", (req.params as any).id);
  return prisma.contact.findFirst({ where: { id: (req.params as any).id, companyId: req.session.companyId } });
});
app.delete("/api/contacts/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  const result = await prisma.contact.deleteMany({ where: { id: (req.params as any).id, companyId: req.session.companyId } });
  if (!result.count) return reply.code(404).send({ error: "Contact not found" });
  await audit(req.session.companyId, req.session.sub, "contact.deleted", "Contact", (req.params as any).id);
  return { ok: true };
});
app.post("/api/contacts/import", { preHandler: [app.authenticate] }, async (req, reply) => {
  const file = await req.file();
  if (!file || !file.filename.toLowerCase().endsWith(".csv")) return reply.code(400).send({ error: "Upload a CSV file" });
  const raw = (await file.toBuffer()).toString("utf8").replace(/^\uFEFF/, "");
  // RFC-4180-style CSV parser: handles quoted commas, escaped quotes, and CRLFs.
  const records: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) {
      if (ch === '"' && raw[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && raw[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(cell => cell.trim() !== "")) records.push(row);
      row = [];
    } else field += ch;
    if (records.length > 5001) return reply.code(400).send({ error: "CSV may contain at most 5000 contacts" });
  }
  if (quoted) return reply.code(400).send({ error: "CSV has an unclosed quoted field" });
  if (field.length || row.length) { row.push(field); if (row.some(cell => cell.trim() !== "")) records.push(row); }
  if (records.length < 2 || records.length > 5001) return reply.code(400).send({ error: "CSV must contain a header and between 1 and 5000 contacts" });
  const headers = records[0].map(x => x.trim().toLowerCase().replace(/\s+/g, ""));
  const firstIndex = headers.indexOf("firstname") >= 0 ? headers.indexOf("firstname") : headers.indexOf("first_name");
  const lastIndex = headers.indexOf("lastname") >= 0 ? headers.indexOf("lastname") : headers.indexOf("last_name");
  const phoneIndex = headers.indexOf("phone"), emailIndex = headers.indexOf("email");
  const companyIndex = headers.indexOf("company") >= 0 ? headers.indexOf("company") : headers.indexOf("companyname");
  const statusIndex = headers.indexOf("status"), notesIndex = headers.indexOf("notes");
  const dncIndex = headers.indexOf("donotcall"), callbackIndex = headers.indexOf("callbackat");
  if (phoneIndex < 0 || firstIndex < 0) return reply.code(400).send({ error: "CSV requires firstName and phone columns. Optional columns: lastName, email, company, status, notes, doNotCall, callbackAt." });
  const rows = records.slice(1).map(cells => {
    const normalizedStatus = (statusIndex >= 0 ? (cells[statusIndex] || "") : "NEW").trim().toUpperCase().replace(/\s+/g, "_");
    const allowedStatus = ["NEW","CALLBACK","INTERESTED","NOT_INTERESTED","WRONG_NUMBER","DO_NOT_CALL","CONVERTED"];
    const status = allowedStatus.includes(normalizedStatus) ? normalizedStatus : "NEW";
    const dncValue = dncIndex >= 0 ? (cells[dncIndex] || "").trim().toLowerCase() : "";
    const callbackText = callbackIndex >= 0 ? (cells[callbackIndex] || "").trim() : "";
    const callbackDate = callbackText ? new Date(callbackText) : null;
    return {
      companyId: req.session.companyId,
      firstName: (cells[firstIndex] || "").trim().slice(0, 100),
      lastName: lastIndex >= 0 ? (cells[lastIndex] || "").trim().slice(0, 100) : "",
      phone: (cells[phoneIndex] || "").trim().slice(0, 40),
      email: emailIndex >= 0 && (cells[emailIndex] || "").trim() ? (cells[emailIndex] || "").trim().slice(0, 254) : null,
      companyName: companyIndex >= 0 ? (cells[companyIndex] || "").trim().slice(0, 160) || null : null,
      status: status as any,
      notes: notesIndex >= 0 ? (cells[notesIndex] || "").slice(0, 5000) || null : null,
      doNotCall: status === "DO_NOT_CALL" || ["true","yes","1"].includes(dncValue),
      callbackAt: callbackDate && !Number.isNaN(callbackDate.getTime()) ? callbackDate : null
    };
  }).filter(x => x.firstName && x.phone);
  if (!rows.length) return reply.code(400).send({ error: "No valid rows found. Every contact must have a first name and phone." });
  const result = await prisma.contact.createMany({ data: rows });
  await audit(req.session.companyId, req.session.sub, "contacts.imported", "Contact", undefined, { count: result.count });
  return reply.code(201).send({ imported: result.count });
});

app.get("/api/campaigns", { preHandler: [app.authenticate] }, async req => prisma.campaign.findMany({ where: { companyId: req.session.companyId }, include: { _count: { select: { contacts: true } } }, orderBy: { createdAt: "desc" } }));
app.post("/api/campaigns", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  const p = z.object({ name: z.string().min(1).max(120), description: z.string().max(1000).optional() }).safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: "Campaign name is required" });
  const c = await prisma.campaign.create({ data: { companyId: req.session.companyId, ...p.data } });
  await audit(req.session.companyId, req.session.sub, "campaign.created", "Campaign", c.id);
  return reply.code(201).send(c);
});
app.get("/api/campaigns/:id/contacts", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  const campaignId = (req.params as any).id;
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, companyId: req.session.companyId } });
  if (!campaign) return reply.code(404).send({ error: "Campaign not found" });
  const links = await prisma.campaignContact.findMany({ where: { campaignId }, include: { contact: true }, orderBy: { createdAt: "desc" } });
  const userIds = [...new Set(links.map(link => link.assignedTo).filter((id): id is string => Boolean(id)))];
  const agents = await prisma.user.findMany({ where: { id: { in: userIds }, companyId: req.session.companyId }, select: { id: true, name: true, email: true } });
  const agentMap = new Map(agents.map(agent => [agent.id, agent]));
  return links.map(link => ({ contact: link.contact, assignedTo: link.assignedTo, assignee: link.assignedTo ? agentMap.get(link.assignedTo) || null : null, addedAt: link.createdAt }));
});
app.post("/api/campaigns/:id/contacts", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  const p = z.object({ contactIds: z.array(z.string()).min(1).max(500), assignedTo: z.string().nullable().optional() }).safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: "Provide contact IDs and an optional agent assignment" });
  const campaignId = (req.params as any).id;
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, companyId: req.session.companyId } });
  if (!campaign) return reply.code(404).send({ error: "Campaign not found" });
  if (p.data.assignedTo) {
    const assignee = await prisma.user.findFirst({ where: { id: p.data.assignedTo, companyId: req.session.companyId, active: true } });
    if (!assignee || assignee.role !== "AGENT") return reply.code(400).send({ error: "Choose an active call agent from this company" });
  }
  const contacts = await prisma.contact.findMany({ where: { id: { in: p.data.contactIds }, companyId: req.session.companyId }, select: { id: true } });
  if (!contacts.length) return reply.code(400).send({ error: "No valid contacts belong to this company" });
  if (p.data.assignedTo !== undefined) {
    await prisma.$transaction(contacts.map(contact => prisma.campaignContact.upsert({
      where: { campaignId_contactId: { campaignId, contactId: contact.id } },
      create: { campaignId, contactId: contact.id, assignedTo: p.data.assignedTo },
      update: { assignedTo: p.data.assignedTo }
    })));
  } else {
    await prisma.campaignContact.createMany({ data: contacts.map(contact => ({ campaignId, contactId: contact.id })), skipDuplicates: true });
  }
  await audit(req.session.companyId, req.session.sub, "campaign.contacts_assigned", "Campaign", campaignId, { count: contacts.length, assignedTo: p.data.assignedTo || null });
  return { accepted: contacts.length, assignedTo: p.data.assignedTo ?? null };
});

const dispositions = ["INTERESTED","CALLBACK_REQUESTED","NO_ANSWER","BUSY","VOICEMAIL","NOT_INTERESTED","MEETING_BOOKED","SALE_COMPLETED","WRONG_NUMBER","DO_NOT_CALL","OTHER"] as const;
app.get("/api/calls", { preHandler: [app.authenticate] }, async req => {
  const isAdmin = supervisorRoles.includes(req.session.role);
  return prisma.callRecord.findMany({ where: { companyId: req.session.companyId, ...(isAdmin ? {} : { agentId: req.session.sub }) }, include: { contact: true, agent: { select: { id: true, name: true, email: true } } }, orderBy: { startedAt: "desc" }, take: 200 });
});
app.post("/api/calls", { preHandler: [app.authenticate] }, async (req, reply) => {
  const p = z.object({ contactId: z.string().optional(), direction: z.enum(["INBOUND","OUTBOUND"]), providerCallId: z.string().max(200).optional(), recordingConsent: z.boolean().default(false) }).safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: "Invalid call details" });
  if (p.data.contactId) {
    const contact = await prisma.contact.findFirst({ where: { id: p.data.contactId, companyId: req.session.companyId, ...(req.session.role === "AGENT" ? { AND: [{ OR: [{ campaignLinks: { some: { assignedTo: req.session.sub } } }, { campaignLinks: { none: {} } }] }] } : {}) } });
    if (!contact) return reply.code(404).send({ error: "Contact not found or not assigned to you" });
    if (p.data.direction === "OUTBOUND" && (contact.doNotCall || contact.status === "DO_NOT_CALL" || contact.status === "WRONG_NUMBER")) return reply.code(403).send({ error: contact.status === "WRONG_NUMBER" ? "Outbound calling is blocked because this contact was marked as a wrong number." : "Outbound calling is blocked for this contact (do-not-call)" });
  }
  const call = await prisma.callRecord.create({ data: { ...p.data, companyId: req.session.companyId, agentId: req.session.sub, status: "INITIATED" } });
  await audit(req.session.companyId, req.session.sub, "call.created", "CallRecord", call.id, { direction: p.data.direction, recordingConsent: p.data.recordingConsent });
  return reply.code(201).send(call);
});
app.patch("/api/calls/:id/finish", { preHandler: [app.authenticate] }, async (req, reply) => {
  const p = z.object({ disposition: z.enum(dispositions), notes: z.string().max(5000).optional(), durationSec: z.number().int().min(0).max(86400).optional(), status: z.enum(["COMPLETED","FAILED","MISSED"]).default("COMPLETED"), callbackAt: z.string().datetime().optional() }).safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: "Choose a valid call ending reason" });
  if (p.data.disposition === "CALLBACK_REQUESTED" && !p.data.callbackAt) return reply.code(400).send({ error: "Choose a callback date and time before saving this outcome." });
  if (p.data.disposition !== "CALLBACK_REQUESTED" && p.data.callbackAt) return reply.code(400).send({ error: "A callback date is only valid for the callback-requested outcome." });
  const id = (req.params as any).id;
  const call = await prisma.callRecord.findFirst({ where: { id, companyId: req.session.companyId, ...(supervisorRoles.includes(req.session.role) ? {} : { agentId: req.session.sub }) } });
  if (!call) return reply.code(404).send({ error: "Call not found" });
  if (call.endedAt) return reply.code(409).send({ error: "Call is already finished" });
  const updated = await prisma.callRecord.update({ where: { id }, data: { status: p.data.status, disposition: p.data.disposition, notes: p.data.notes, durationSec: p.data.durationSec, endedAt: new Date() } });
  const statusMap: Record<string,string> = { INTERESTED: "INTERESTED", CALLBACK_REQUESTED: "CALLBACK", NOT_INTERESTED: "NOT_INTERESTED", WRONG_NUMBER: "WRONG_NUMBER", SALE_COMPLETED: "CONVERTED", DO_NOT_CALL: "DO_NOT_CALL" };
  const contactStatus = statusMap[p.data.disposition];
  if (call.contactId && contactStatus) await prisma.contact.updateMany({ where: { id: call.contactId, companyId: req.session.companyId }, data: { status: contactStatus as any, callbackAt: p.data.disposition === "CALLBACK_REQUESTED" ? new Date(p.data.callbackAt!) : null, ...(p.data.disposition === "DO_NOT_CALL" ? { doNotCall: true } : {}) } });
  await audit(req.session.companyId, req.session.sub, "call.finished", "CallRecord", id, { disposition: p.data.disposition, status: p.data.status });
  return updated;
});

app.get("/api/voip/client-config", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (req.session.role !== "AGENT") return reply.code(403).send({ error: "Only call-agent accounts can retrieve browser SIP credentials." });
  const [companyConfig, user] = await Promise.all([
    prisma.voipConfig.findUnique({ where: { companyId: req.session.companyId } }),
    prisma.user.findFirst({ where: { id: req.session.sub, companyId: req.session.companyId, active: true } })
  ]);
  if (!companyConfig || !companyConfig.websocketUrl) return reply.code(409).send({ error: "VoIP is not configured with a secure WebSocket URL" });
  if (!user) return reply.code(401).send({ error: "Active user not found" });
  const secret = user.encryptedSipSecret || companyConfig.encryptedSecret;
  const sipUsername = user.encryptedSipSecret ? user.sipUsername : companyConfig.sipUsername;
  const sipDomain = user.encryptedSipSecret ? user.sipDomain : companyConfig.sipDomain;
  if (!secret || !sipUsername || !sipDomain) return reply.code(409).send({ error: "SIP credentials are incomplete for this agent" });
  const cryptoKey = process.env.VOIP_ENCRYPTION_KEY;
  if (!cryptoKey || cryptoKey.length < 32) return reply.code(503).send({ error: "Server encryption key is not configured" });
  const crypto = await import("node:crypto");
  try {
    const [ivText, tagText, encryptedText] = secret.split(".");
    const key = crypto.createHash("sha256").update(cryptoKey).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
    decipher.setAuthTag(Buffer.from(tagText, "base64"));
    const password = Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64")), decipher.final()]).toString("utf8");
    let iceServers: any[] | undefined;
    if (companyConfig.encryptedIceServers) {
      const [iceIv, iceTag, iceCiphertext] = companyConfig.encryptedIceServers.split(".");
      const iceDecipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iceIv, "base64"));
      iceDecipher.setAuthTag(Buffer.from(iceTag, "base64"));
      iceServers = JSON.parse(Buffer.concat([iceDecipher.update(Buffer.from(iceCiphertext, "base64")), iceDecipher.final()]).toString("utf8"));
    }
    await audit(req.session.companyId, req.session.sub, "voip.client_config_accessed", "VoipConfig", companyConfig.id);
    return {
      uri: `sip:${sipUsername}@${sipDomain}`, sipDomain, websocketUrl: companyConfig.websocketUrl,
      username: sipUsername, password, displayName: user.name,
      recordingEnabled: companyConfig.recordingEnabled, recordingNoticeText: companyConfig.recordingNoticeText, iceServers
    };
  } catch {
    return reply.code(503).send({ error: "VoIP credentials could not be decrypted; check the server encryption key" });
  }
});
app.get("/api/voip/config", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, adminRoles)) return;
  const v = await prisma.voipConfig.findUnique({ where: { companyId: req.session.companyId } });
  if (!v) return { configured: false };
  return { configured: true, provider: v.provider, sipDomain: v.sipDomain, sipUsername: v.sipUsername, outboundCallerId: v.outboundCallerId, websocketUrl: v.websocketUrl, recordingEnabled: v.recordingEnabled, recordingNoticeText: v.recordingNoticeText, hasSecret: Boolean(v.encryptedSecret), hasIceServers: Boolean(v.encryptedIceServers) };
});
app.put("/api/voip/config", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, adminRoles)) return;
  const p = z.object({ provider: z.string().min(1).max(80), sipDomain: z.string().min(1).max(255), sipUsername: z.string().min(1).max(255), sipPassword: z.string().min(1).max(500).optional(), outboundCallerId: z.string().max(50).optional(), websocketUrl: z.string().url().optional().or(z.literal("")), recordingEnabled: z.boolean().default(false), recordingNoticeText: z.string().max(1000).optional(), iceServersJson: z.string().max(4000).optional(), clearIceServers: z.boolean().optional() }).safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: "Invalid VoIP configuration" });
  if (p.data.recordingEnabled && !p.data.recordingNoticeText?.trim()) return reply.code(400).send({ error: "Add the company-approved recording notice before enabling call recording." });
  if (!p.data.sipPassword && !await prisma.voipConfig.findUnique({ where: { companyId: req.session.companyId } })) return reply.code(400).send({ error: "SIP password is required for first setup" });
  const cryptoKey = process.env.VOIP_ENCRYPTION_KEY;
  if (p.data.sipPassword && (!cryptoKey || cryptoKey.length < 32)) return reply.code(503).send({ error: "Server administrator must configure VOIP_ENCRYPTION_KEY (32+ characters) before storing credentials" });
  // ICE server configuration may include TURN usernames/passwords, so encrypt it too.
  let iceServers: any[] | undefined;
  if (p.data.iceServersJson?.trim()) {
    let parsedJson: unknown;
    try { parsedJson = JSON.parse(p.data.iceServersJson); } catch { return reply.code(400).send({ error: "ICE servers must be valid JSON." }); }
    const iceSchema = z.array(z.object({
      urls: z.union([z.string().min(1).max(500), z.array(z.string().min(1).max(500)).min(1).max(8)]),
      username: z.string().max(255).optional(),
      credential: z.string().max(500).optional(),
      credentialType: z.enum(["password", "oauth"]).optional()
    })).min(1).max(10);
    const parsed = iceSchema.safeParse(parsedJson);
    if (!parsed.success) return reply.code(400).send({ error: "ICE servers must be an array of objects with urls and optional username/credential fields." });
    iceServers = parsed.data;
  }
  // AES-GCM encryption: never store VoIP or TURN passwords in plaintext.
  let encryptedSecret: string | undefined;
  let encryptedIceServers: string | undefined;
  if (p.data.sipPassword) {
    const crypto = await import("node:crypto");
    const key = crypto.createHash("sha256").update(cryptoKey!).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(p.data.sipPassword, "utf8"), cipher.final()]);
    encryptedSecret = [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
  }
  if (iceServers) {
    if (!cryptoKey || cryptoKey.length < 32) return reply.code(503).send({ error: "VOIP_ENCRYPTION_KEY is required to encrypt ICE server credentials." });
    const crypto = await import("node:crypto");
    const key = crypto.createHash("sha256").update(cryptoKey).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(iceServers), "utf8"), cipher.final()]);
    encryptedIceServers = [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
  }
  const data: any = { provider: p.data.provider, sipDomain: p.data.sipDomain, sipUsername: p.data.sipUsername, outboundCallerId: p.data.outboundCallerId, websocketUrl: p.data.websocketUrl || null, recordingEnabled: p.data.recordingEnabled, recordingNoticeText: p.data.recordingNoticeText };
  if (encryptedSecret) data.encryptedSecret = encryptedSecret;
  if (encryptedIceServers) data.encryptedIceServers = encryptedIceServers;
  if (p.data.clearIceServers && iceServers) return reply.code(400).send({ error: "Do not set both ICE server JSON and clearIceServers." });
  if (p.data.clearIceServers) data.encryptedIceServers = null;
  const config = await prisma.voipConfig.upsert({ where: { companyId: req.session.companyId }, create: { ...data, companyId: req.session.companyId, encryptedSecret: encryptedSecret! }, update: data });
  await audit(req.session.companyId, req.session.sub, "voip.configured", "VoipConfig", config.id);
  return { ok: true, configured: true };
});

app.get("/api/recordings", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  const calls = await prisma.callRecord.findMany({ where: { companyId: req.session.companyId, recordingKey: { not: null } }, include: { contact: true, agent: { select: { id: true, name: true } } }, orderBy: { startedAt: "desc" }, take: 200 });
  return calls.map(c => ({ id: c.id, startedAt: c.startedAt, durationSec: c.durationSec, disposition: c.disposition, recordingMime: c.recordingMime, contact: c.contact, agent: c.agent, playbackUrl: `/api/recordings/${c.id}/audio` }));
});
app.post("/api/calls/:id/recording", { preHandler: [app.authenticate] }, async (req, reply) => {
  const callId = (req.params as any).id;
  const call = await prisma.callRecord.findFirst({ where: { id: callId, companyId: req.session.companyId, ...(supervisorRoles.includes(req.session.role) ? {} : { agentId: req.session.sub }) } });
  if (!call) return reply.code(404).send({ error: "Call not found" });
  const voip = await prisma.voipConfig.findUnique({ where: { companyId: req.session.companyId } });
  if (!voip?.recordingEnabled) return reply.code(403).send({ error: "Call recording is disabled by the company administrator" });
  if (!call.recordingConsent) return reply.code(400).send({ error: "Recording consent must be recorded before uploading audio" });
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: "Audio file is required" });
  const mime = file.mimetype.split(";")[0].trim().toLowerCase();
  if (!["audio/webm","audio/ogg","audio/wav","audio/mpeg","audio/mp4"].includes(mime)) return reply.code(400).send({ error: "Unsupported audio format" });
  const buffer = await file.toBuffer();
  if (buffer.length < 100 || buffer.length > 100_000_000) return reply.code(413).send({ error: "Recording must be between 100 bytes and 100 MB" });
  try {
    const recordingKey = await saveEncryptedRecording(req.session.companyId, callId, buffer);
    const updated = await prisma.callRecord.update({ where: { id: callId }, data: { recordingKey, recordingMime: mime, recordingBytes: buffer.length } });
    await audit(req.session.companyId, req.session.sub, "call.recording_uploaded", "CallRecord", callId, { bytes: buffer.length, mime });
    return reply.code(201).send({ ok: true, callId: updated.id, bytes: buffer.length });
  } catch (error) {
    req.log.error({ err: error }, "Recording storage failed");
    return reply.code(503).send({ error: "Recording storage is unavailable; verify server encryption key and persistent storage" });
  }
});
app.get("/api/recordings/:id/audio", { preHandler: [app.authenticate] }, async (req, reply) => {
  const callId = (req.params as any).id;
  const call = await prisma.callRecord.findFirst({ where: { id: callId, companyId: req.session.companyId, recordingKey: { not: null }, ...(supervisorRoles.includes(req.session.role) ? {} : { agentId: req.session.sub }) } });
  if (!call || !call.recordingKey) return reply.code(404).send({ error: "Recording not found" });
  try {
    const audio = await readEncryptedRecording(call.recordingKey);
    await audit(req.session.companyId, req.session.sub, "call.recording_played", "CallRecord", callId);
    return reply.header("Content-Type", call.recordingMime || "audio/webm").header("Content-Length", String(audio.length)).header("Cache-Control", "private, no-store").send(audio);
  } catch (error) {
    req.log.error({ err: error }, "Recording playback failed");
    return reply.code(503).send({ error: "Recording file is unavailable or cannot be decrypted" });
  }
});

function encryptLeadScoutSecret(value: string) {
  const secretKey = process.env.VOIP_ENCRYPTION_KEY;
  if (!secretKey || secretKey.length < 32) throw new Error("Server administrator must configure VOIP_ENCRYPTION_KEY (32+ characters).");
  const key = Buffer.from(secretKey).subarray(0, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}
function decryptLeadScoutSecret(value: string) {
  const secretKey = process.env.VOIP_ENCRYPTION_KEY;
  if (!secretKey || secretKey.length < 32) throw new Error("Server encryption key is not configured.");
  const [ivText, tagText, encryptedText] = value.split(".");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(secretKey).subarray(0, 32), Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64")), decipher.final()]).toString("utf8");
}
app.get("/api/leadscout/providers", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, adminRoles)) return;
  const rows = await prisma.integrationCredential.findMany({ where: { companyId: req.session.companyId }, select: { provider: true, updatedAt: true } });
  return { providers: [{ provider: "brave", label: "Brave Search", configured: rows.some(x => x.provider === "brave"), updatedAt: rows.find(x => x.provider === "brave")?.updatedAt || null }] };
});
app.put("/api/leadscout/providers/:provider", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, adminRoles)) return;
  const provider = String((req.params as any).provider || "").toLowerCase();
  if (provider !== "brave") return reply.code(400).send({ error: "Unsupported provider." });
  const parsed = z.object({ apiKey: z.string().trim().min(10).max(500) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Enter a valid provider API key." });
  let encryptedApiKey: string;
  try { encryptedApiKey = encryptLeadScoutSecret(parsed.data.apiKey); }
  catch (e: any) { return reply.code(503).send({ error: e.message }); }
  await prisma.integrationCredential.upsert({
    where: { companyId_provider: { companyId: req.session.companyId, provider } },
    create: { companyId: req.session.companyId, provider, encryptedApiKey },
    update: { encryptedApiKey }
  });
  await audit(req.session.companyId, req.session.sub, "leadscout.provider_key_saved", "IntegrationCredential", provider);
  return reply.code(200).send({ provider, configured: true, message: "Provider key saved securely." });
});
app.delete("/api/leadscout/providers/:provider", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, adminRoles)) return;
  const provider = String((req.params as any).provider || "").toLowerCase();
  await prisma.integrationCredential.deleteMany({ where: { companyId: req.session.companyId, provider } });
  await audit(req.session.companyId, req.session.sub, "leadscout.provider_key_deleted", "IntegrationCredential", provider);
  return { provider, configured: false };
});
app.get("/api/leadscout/jobs", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  return prisma.leadResearchJob.findMany({ where: { companyId: req.session.companyId }, include: { _count: { select: { leads: true } } }, orderBy: { createdAt: "desc" }, take: 50 });
});
app.get("/api/leadscout/leads", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  const query = z.object({ q: z.string().max(200).optional() }).safeParse(req.query);
  if (!query.success) return reply.code(400).send({ error: "Invalid search filter." });
  const q = query.data.q?.trim();
  return prisma.leadRecord.findMany({ where: { companyId: req.session.companyId, ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { description: { contains: q, mode: "insensitive" } }, { location: { contains: q, mode: "insensitive" } }] } : {}) }, orderBy: { createdAt: "desc" }, take: 500 });
});
app.post("/api/leadscout/research", { preHandler: [app.authenticate], config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  const parsed = z.object({ prompt: z.string().trim().min(12).max(1000), count: z.number().int().min(1).max(20).default(10) }).safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Describe the businesses you want (12–1000 characters) and choose 1–20 results." });
  const credential = await prisma.integrationCredential.findUnique({ where: { companyId_provider: { companyId: req.session.companyId, provider: "brave" } } });
  if (!credential) return reply.code(400).send({ error: "Add a Brave Search API key in LeadScout settings before researching." });
  let apiKey: string;
  try { apiKey = decryptLeadScoutSecret(credential.encryptedApiKey); }
  catch (e: any) { req.log.error({ err: e }, "LeadScout key decryption failed"); return reply.code(503).send({ error: "Could not decrypt provider key; check the server encryption key." }); }
  const job = await prisma.leadResearchJob.create({ data: { companyId: req.session.companyId, createdBy: req.session.sub, prompt: parsed.data.prompt, status: "RUNNING" } });
  try {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", parsed.data.prompt);
    url.searchParams.set("count", String(parsed.data.count));
    const response = await fetch(url, { headers: { "X-Subscription-Token": apiKey, "Accept": "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      await prisma.leadResearchJob.update({ where: { id: job.id }, data: { status: "FAILED" } });
      req.log.warn({ status: response.status }, "LeadScout provider request failed");
      return reply.code(response.status === 401 || response.status === 403 ? 502 : 503).send({ error: response.status === 401 || response.status === 403 ? "Provider rejected this API key. Check it in settings." : "Search provider is temporarily unavailable." });
    }
    const data: any = await response.json();
    const results = (Array.isArray(data?.web?.results) ? data.web.results : []).slice(0, parsed.data.count)
      .filter((x: any) => typeof x.url === "string" && typeof x.title === "string" && /^https?:\/\//i.test(x.url))
      .map((x: any) => ({ companyId: req.session.companyId, jobId: job.id, name: String(x.title).slice(0, 300), website: new URL(x.url).origin, description: String(x.description || "").slice(0, 2000), sourceUrl: String(x.url).slice(0, 2000) }));
    if (results.length) await prisma.leadRecord.createMany({ data: results, skipDuplicates: true });
    const saved = await prisma.leadRecord.count({ where: { companyId: req.session.companyId, jobId: job.id } });
    await prisma.leadResearchJob.update({ where: { id: job.id }, data: { status: "COMPLETED", resultCount: saved } });
    await audit(req.session.companyId, req.session.sub, "leadscout.research_completed", "LeadResearchJob", job.id, { results: saved });
    return { jobId: job.id, prompt: job.prompt, resultCount: saved, leads: await prisma.leadRecord.findMany({ where: { companyId: req.session.companyId, jobId: job.id }, orderBy: { createdAt: "desc" } }) };
  } catch (e: any) {
    await prisma.leadResearchJob.update({ where: { id: job.id }, data: { status: "FAILED" } }).catch(() => {});
    req.log.error({ err: e }, "LeadScout research failed");
    return reply.code(503).send({ error: "Research failed due to a provider or network error. Please try again." });
  }
});
app.get("/api/leadscout/export.csv", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  const leads = await prisma.leadRecord.findMany({ where: { companyId: req.session.companyId }, orderBy: { createdAt: "desc" }, take: 5000 });
  const cell = (v: unknown) => { const value = String(v ?? ""); return /^[=+@\-\t\r]/.test(value) ? "'" + value : value; };
  const csv = ["Name,Website,Description,Source URL,Collected At", ...leads.map(x => [x.name,x.website,x.description,x.sourceUrl,x.createdAt.toISOString()].map(v => '"' + cell(v).replaceAll('"','""') + '"').join(","))].join("\r\n");
  return reply.header("Content-Type", "text/csv; charset=utf-8").header("Content-Disposition", 'attachment; filename="leadscout-leads.csv"').send(csv);
});
app.get("/api/reports/summary", { preHandler: [app.authenticate] }, async req => {
  const companyId = req.session.companyId;
  const where: any = { companyId, ...(supervisorRoles.includes(req.session.role) ? {} : { agentId: req.session.sub }) };
  const [total, completed, callback, recordings] = await Promise.all([
    prisma.callRecord.count({ where }),
    prisma.callRecord.count({ where: { ...where, status: "COMPLETED" } }),
    prisma.contact.count({ where: { companyId, status: "CALLBACK" } }),
    prisma.callRecord.count({ where: { ...where, recordingKey: { not: null } } })
  ]);
  return { totalCalls: total, completedCalls: completed, callbacksDue: callback, recordings };
});
app.get("/api/audit", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  return prisma.auditLog.findMany({ where: { companyId: req.session.companyId }, orderBy: { createdAt: "desc" }, take: 200 });
});
app.setErrorHandler((error, req, reply) => {
  req.log.error({ err: error }, "Request failed");
  const statusCode = (error as any)?.statusCode;
  if (statusCode && statusCode < 500) return reply.code(statusCode).send({ error: (error as any).message });
  return reply.code(500).send({ error: "Internal server error" });
});
app.addHook("onClose", async () => { await prisma.$disconnect(); });
app.listen({ host: "0.0.0.0", port: PORT }).catch(err => { app.log.error(err); process.exit(1); });