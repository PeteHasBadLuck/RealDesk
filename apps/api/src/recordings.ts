import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const root = resolve(process.env.RECORDINGS_DIR || "/data/recordings");
function keyBytes() {
  const secret = process.env.RECORDING_ENCRYPTION_KEY || process.env.VOIP_ENCRYPTION_KEY;
  if (!secret || secret.length < 32) throw new Error("RECORDING_ENCRYPTION_KEY must be configured with at least 32 characters");
  return createHash("sha256").update(secret).digest();
}
function safePath(key: string) {
  const path = resolve(root, key);
  if (path !== root && !path.startsWith(root + sep)) throw new Error("Invalid recording key");
  return path;
}
export async function saveEncryptedRecording(companyId: string, callId: string, audio: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const encrypted = Buffer.concat([cipher.update(audio), cipher.final()]);
  const tag = cipher.getAuthTag();
  const relativeKey = join(companyId, callId + ".enc");
  const path = safePath(relativeKey);
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  await writeFile(path, Buffer.concat([Buffer.from("RDA1"), iv, tag, encrypted]), { mode: 0o600 });
  return relativeKey;
}
export async function readEncryptedRecording(key: string) {
  const data = await readFile(safePath(key));
  if (data.length < 32 || data.subarray(0, 4).toString() !== "RDA1") throw new Error("Invalid recording file");
  const iv = data.subarray(4, 16), tag = data.subarray(16, 32), encrypted = data.subarray(32);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}