import Fastify, { FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
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

type Session = { sub: string; companyId: string; role: Role; email: string };
declare module "fastify" {
  interface FastifyRequest { session: Session }
  interface FastifyInstance { authenticate: (req: FastifyRequest, reply: any) => Promise<void> }
}
app.decorate("authenticate", async (req: FastifyRequest, reply: any) => {
  try {
    await req.jwtVerify();
    const payload = req.user as Session;
    const user = await prisma.user.findFirst({ where: { id: payload.sub, companyId: payload.companyId, active: true } });
    if (!user) return reply.code(401).send({ error: "Session is no longer valid" });
    req.session = { sub: user.id, companyId: user.companyId, role: user.role, email: user.email };
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

app.post("/api/auth/login", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async (req, reply) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return reply.code(400).send({ error: "Enter a valid email and password" });
  const email = parsed.data.email.toLowerCase();
  const candidates = await prisma.user.findMany({ where: { email, active: true }, take: 2, include: { company: true } });
  if (candidates.length !== 1 || !(await bcrypt.compare(parsed.data.password, candidates[0].passwordHash)))
    return reply.code(401).send({ error: "Invalid credentials" });
  const user = candidates[0];
  const token = app.jwt.sign({ sub: user.id, companyId: user.companyId, role: user.role, email: user.email });
  return { token, user: { id: user.id, name: user.name, email: user.email, role: user.role, company: { name: user.company.name } } };
});
app.get("/api/auth/me", { preHandler: [app.authenticate] }, async req => {
  const user = await prisma.user.findFirstOrThrow({ where: { id: req.session.sub, companyId: req.session.companyId }, select: { id: true, name: true, email: true, role: true, company: { select: { name: true } } } });
  return { user };
});

app.get("/api/users", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, supervisorRoles)) return;
  const users = await prisma.user.findMany({ where: { companyId: req.session.companyId }, select: { id: true, name: true, email: true, role: true, active: true, sipUsername: true, sipDomain: true, encryptedSipSecret: true, createdAt: true }, orderBy: { createdAt: "desc" } });
  return users.map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, hasSipCredentials: Boolean(u.encryptedSipSecret), sipUsername: u.sipUsername, sipDomain: u.sipDomain, createdAt: u.createdAt }));
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
  const p = z.object({ active: z.boolean().optional(), role: z.enum(["ADMIN", "SUPERVISOR", "AGENT"]).optional(), name: z.string().min(1).max(120).optional() }).safeParse(req.body);
  if (!p.success || Object.keys(p.data || {}).length === 0) return reply.code(400).send({ error: "Invalid update" });
  const id = (req.params as any).id;
  if (id === req.session.sub) return reply.code(400).send({ error: "Use another administrator to change your own role or active state" });
  const result = await prisma.user.updateMany({ where: { id, companyId: req.session.companyId }, data: p.data });
  if (!result.count) return reply.code(404).send({ error: "User not found" });
  await audit(req.session.companyId, req.session.sub, "user.updated", "User", id);
  return { ok: true };
});

app.get("/api/contacts", { preHandler: [app.authenticate] }, async req => {
  const q = (req.query as any)?.q?.toString().slice(0, 100);
  const status = (req.query as any)?.status?.toString();
  const where: any = { companyId: req.session.companyId };
  if (req.session.role === "AGENT") where.OR = [{ campaignLinks: { some: { assignedTo: req.session.sub } } }, { campaignLinks: { none: {} } }];
  if (status && ["NEW","CALLBACK","INTERESTED","NOT_INTERESTED","DO_NOT_CALL","CONVERTED"].includes(status)) where.status = status;
  if (q) where.OR = [{ firstName: { contains: q, mode: "insensitive" } }, { lastName: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { email: { contains: q, mode: "insensitive" } }, { companyName: { contains: q, mode: "insensitive" } }];
  return prisma.contact.findMany({ where, orderBy: { updatedAt: "desc" }, take: 500 });
});
const contactSchema = z.object({ firstName: z.string().min(1).max(100), lastName: z.string().max(100).optional().default(""), phone: z.string().min(3).max(40), email: z.string().email().max(254).optional().or(z.literal("")), companyName: z.string().max(160).optional(), status: z.enum(["NEW","CALLBACK","INTERESTED","NOT_INTERESTED","DO_NOT_CALL","CONVERTED"]).optional(), notes: z.string().max(5000).optional(), doNotCall: z.boolean().optional() });
app.post("/api/contacts", { preHandler: [app.authenticate] }, async (req, reply) => {
  const p = contactSchema.safeParse(req.body); if (!p.success) return reply.code(400).send({ error: "Invalid contact details", details: p.error.flatten() });
  const contact = await prisma.contact.create({ data: { ...p.data, email: p.data.email || null, companyId: req.session.companyId } });
  await audit(req.session.companyId, req.session.sub, "contact.created", "Contact", contact.id);
  return reply.code(201).send(contact);
});
app.patch("/api/contacts/:id", { preHandler: [app.authenticate] }, async (req, reply) => {
  const p = contactSchema.partial().safeParse(req.body); if (!p.success || !Object.keys(p.data || {}).length) return reply.code(400).send({ error: "Invalid contact update" });
  const data: any = { ...p.data }; if (data.email === "") data.email = null;
  const result = await prisma.contact.updateMany({ where: { id: (req.params as any).id, companyId: req.session.companyId }, data });
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
  if (phoneIndex < 0 || firstIndex < 0) return reply.code(400).send({ error: "CSV requires firstName and phone columns. Optional columns: lastName, email, company." });
  const rows = records.slice(1).map(cells => ({
    companyId: req.session.companyId,
    firstName: (cells[firstIndex] || "").trim().slice(0, 100),
    lastName: lastIndex >= 0 ? (cells[lastIndex] || "").trim().slice(0, 100) : "",
    phone: (cells[phoneIndex] || "").trim().slice(0, 40),
    email: emailIndex >= 0 && (cells[emailIndex] || "").trim() ? (cells[emailIndex] || "").trim().slice(0, 254) : null,
    companyName: companyIndex >= 0 ? (cells[companyIndex] || "").trim().slice(0, 160) || null : null
  })).filter(x => x.firstName && x.phone);
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
  if (p.data.contactId && !await prisma.contact.findFirst({ where: { id: p.data.contactId, companyId: req.session.companyId } })) return reply.code(404).send({ error: "Contact not found" });
  const call = await prisma.callRecord.create({ data: { ...p.data, companyId: req.session.companyId, agentId: req.session.sub, status: "INITIATED" } });
  await audit(req.session.companyId, req.session.sub, "call.created", "CallRecord", call.id);
  return reply.code(201).send(call);
});
app.patch("/api/calls/:id/finish", { preHandler: [app.authenticate] }, async (req, reply) => {
  const p = z.object({ disposition: z.enum(dispositions), notes: z.string().max(5000).optional(), durationSec: z.number().int().min(0).max(86400).optional(), status: z.enum(["COMPLETED","FAILED","MISSED"]).default("COMPLETED") }).safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: "Choose a valid call ending reason" });
  const id = (req.params as any).id;
  const call = await prisma.callRecord.findFirst({ where: { id, companyId: req.session.companyId, ...(supervisorRoles.includes(req.session.role) ? {} : { agentId: req.session.sub }) } });
  if (!call) return reply.code(404).send({ error: "Call not found" });
  if (call.endedAt) return reply.code(409).send({ error: "Call is already finished" });
  const updated = await prisma.callRecord.update({ where: { id }, data: { status: p.data.status, disposition: p.data.disposition, notes: p.data.notes, durationSec: p.data.durationSec, endedAt: new Date() } });
  const statusMap: Record<string,string> = { INTERESTED: "INTERESTED", CALLBACK_REQUESTED: "CALLBACK", NOT_INTERESTED: "NOT_INTERESTED", SALE_COMPLETED: "CONVERTED", DO_NOT_CALL: "DO_NOT_CALL" };
  const contactStatus = statusMap[p.data.disposition];
  if (call.contactId && contactStatus) await prisma.contact.updateMany({ where: { id: call.contactId, companyId: req.session.companyId }, data: { status: contactStatus as any, ...(p.data.disposition === "DO_NOT_CALL" ? { doNotCall: true } : {}) } });
  await audit(req.session.companyId, req.session.sub, "call.finished", "CallRecord", id, { disposition: p.data.disposition, status: p.data.status });
  return updated;
});

app.get("/api/voip/client-config", { preHandler: [app.authenticate] }, async (req, reply) => {
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
    await audit(req.session.companyId, req.session.sub, "voip.client_config_accessed", "VoipConfig", companyConfig.id);
    return {
      uri: `sip:${sipUsername}@${sipDomain}`, sipDomain, websocketUrl: companyConfig.websocketUrl,
      username: sipUsername, password, displayName: user.name,
      recordingEnabled: companyConfig.recordingEnabled, recordingNoticeText: companyConfig.recordingNoticeText
    };
  } catch {
    return reply.code(503).send({ error: "VoIP credentials could not be decrypted; check the server encryption key" });
  }
});
app.get("/api/voip/config", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, adminRoles)) return;
  const v = await prisma.voipConfig.findUnique({ where: { companyId: req.session.companyId } });
  if (!v) return { configured: false };
  return { configured: true, provider: v.provider, sipDomain: v.sipDomain, sipUsername: v.sipUsername, outboundCallerId: v.outboundCallerId, websocketUrl: v.websocketUrl, recordingEnabled: v.recordingEnabled, recordingNoticeText: v.recordingNoticeText, hasSecret: Boolean(v.encryptedSecret) };
});
app.put("/api/voip/config", { preHandler: [app.authenticate] }, async (req, reply) => {
  if (!requireRole(req, reply, adminRoles)) return;
  const p = z.object({ provider: z.string().min(1).max(80), sipDomain: z.string().min(1).max(255), sipUsername: z.string().min(1).max(255), sipPassword: z.string().min(1).max(500).optional(), outboundCallerId: z.string().max(50).optional(), websocketUrl: z.string().url().optional().or(z.literal("")), recordingEnabled: z.boolean().default(false), recordingNoticeText: z.string().max(1000).optional() }).safeParse(req.body);
  if (!p.success) return reply.code(400).send({ error: "Invalid VoIP configuration" });
  if (!p.data.sipPassword && !await prisma.voipConfig.findUnique({ where: { companyId: req.session.companyId } })) return reply.code(400).send({ error: "SIP password is required for first setup" });
  const cryptoKey = process.env.VOIP_ENCRYPTION_KEY;
  if (p.data.sipPassword && (!cryptoKey || cryptoKey.length < 32)) return reply.code(503).send({ error: "Server administrator must configure VOIP_ENCRYPTION_KEY (32+ characters) before storing credentials" });
  // AES-GCM encryption: never store a VoIP password in plaintext.
  let encryptedSecret: string | undefined;
  if (p.data.sipPassword) {
    const crypto = await import("node:crypto");
    const key = crypto.createHash("sha256").update(cryptoKey!).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(p.data.sipPassword, "utf8"), cipher.final()]);
    encryptedSecret = [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
  }
  const data: any = { provider: p.data.provider, sipDomain: p.data.sipDomain, sipUsername: p.data.sipUsername, outboundCallerId: p.data.outboundCallerId, websocketUrl: p.data.websocketUrl || null, recordingEnabled: p.data.recordingEnabled, recordingNoticeText: p.data.recordingNoticeText };
  if (encryptedSecret) data.encryptedSecret = encryptedSecret;
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