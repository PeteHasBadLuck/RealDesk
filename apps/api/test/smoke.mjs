import assert from "node:assert/strict";

const base = process.env.API_BASE_URL || "http://127.0.0.1:3001";
const ownerEmail = process.env.SEED_ADMIN_EMAIL || "owner@realdesk.test";
const ownerPassword = process.env.SEED_ADMIN_PASSWORD || "CI_Only_Admin_Password_9284!";

async function call(path, options = {}) {
  const { token, method = "GET", body, form, expected = 200 } = options;
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(base + path, {
    method,
    headers,
    body: form || (body !== undefined ? JSON.stringify(body) : undefined)
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  assert.equal(
    response.status,
    expected,
    method + " " + path + " expected HTTP " + expected + " but got " + response.status + ": " +
      (Buffer.isBuffer(data) ? "<binary>" : JSON.stringify(data))
  );
  return { response, data };
}

async function login(email, password) {
  const { data } = await call("/api/auth/login", { method: "POST", body: { email, password } });
  assert.ok(data.token, "login should return a token");
  return { token: data.token, user: data.user };
}

async function createContact(token, firstName, phone) {
  const { data } = await call("/api/contacts", {
    method: "POST",
    token,
    expected: 201,
    body: { firstName, lastName: "Test", phone, email: firstName.toLowerCase() + "@example.test", companyName: "QA Company", status: "NEW" }
  });
  return data;
}

async function createAgent(ownerToken, name, email, sipUsername) {
  const { data } = await call("/api/users", {
    method: "POST",
    token: ownerToken,
    expected: 201,
    body: {
      name,
      email,
      password: "CI_Agent_Password_" + sipUsername + "_9284!",
      role: "AGENT",
      sipUsername,
      sipDomain: "pbx.example.test",
      sipPassword: "ci-only-sip-secret-" + sipUsername
    }
  });
  assert.equal(data.hasSipCredentials, true);
  return data;
}

async function main() {
  const health = await call("/health");
  assert.equal(health.data.ok, true);

  const owner = await login(ownerEmail, ownerPassword);
  assert.equal(owner.user.role, "OWNER");

  // LeadScout provider keys are encrypted, masked, and scoped to one company.
  await call("/api/leadscout/providers/brave", {
    method: "PUT", token: owner.token, expected: 200,
    body: { apiKey: "ci-brave-search-api-key-not-real" }
  });
  const leadProviders = await call("/api/leadscout/providers", { token: owner.token });
  assert.equal(leadProviders.data.providers.find(p => p.provider === "brave").configured, true);
  assert.ok(!JSON.stringify(leadProviders.data).includes("ci-brave-search-api-key-not-real"), "provider key must never be returned");

  await call("/api/auth/register-company", {
    method: "POST", expected: 400,
    body: { companyName: "Tiny", name: "New Owner", email: "weakpass@realdesk.test", password: "short" }
  });
  const secondRegistration = await call("/api/auth/register-company", {
    method: "POST", expected: 201,
    body: { companyName: "Second Test Company", name: "Second Owner", email: "owner2@realdesk.test", password: "CI_Second_Company_Owner_Password_9284!" }
  });
  assert.equal(secondRegistration.data.user.role, "OWNER");
  assert.equal(secondRegistration.data.user.company.name, "Second Test Company");
  const secondCompanyProviders = await call("/api/leadscout/providers", { token: secondRegistration.data.token });
  assert.equal(secondCompanyProviders.data.providers.find(p => p.provider === "brave").configured, false, "provider keys must be isolated by company");
  await call("/api/auth/register-company", {
    method: "POST", expected: 409,
    body: { companyName: "Duplicate Email", name: "Duplicate Owner", email: "owner2@realdesk.test", password: "CI_Second_Company_Owner_Password_9284!" }
  });
  const isolatedCompanyContact = await createContact(secondRegistration.data.token, "Isolated", "+34919999999");
  const ownerOneContacts = await call("/api/contacts", { token: owner.token });
  assert.ok(!ownerOneContacts.data.some(c => c.id === isolatedCompanyContact.id), "company contacts must not leak across tenants");
  await call("/api/contacts/" + isolatedCompanyContact.id, { token: owner.token, expected: 404 });
  const unauthenticated = await call("/api/contacts", { expected: 401 });
  assert.ok(unauthenticated.data.error);

  // Recording cannot be enabled without an explicit company notice.
  await call("/api/voip/config", {
    method: "PUT",
    token: owner.token,
    expected: 400,
    body: {
      provider: "CI SIP PBX",
      sipDomain: "pbx.example.test",
      sipUsername: "company-test",
      sipPassword: "ci-only-company-secret",
      websocketUrl: "wss://pbx.example.test/ws",
      recordingEnabled: true,
      recordingNoticeText: ""
    }
  });

  const notice = "CI test recording notice. This is a synthetic test call.";
  await call("/api/voip/config", {
    method: "PUT",
    token: owner.token,
    expected: 200,
    body: {
      provider: "CI SIP PBX",
      sipDomain: "pbx.example.test",
      sipUsername: "company-test",
      sipPassword: "ci-only-company-secret",
      outboundCallerId: "+34900000000",
      websocketUrl: "wss://pbx.example.test/ws",
      recordingEnabled: true,
      recordingNoticeText: notice,
      iceServersJson: JSON.stringify([
        { urls: "stun:stun.example.test:3478" },
        { urls: "turn:turn.example.test:3478", username: "turn-ci-user", credential: "turn-ci-password" }
      ])
    }
  });
  const savedConfig = await call("/api/voip/config", { token: owner.token });
  assert.equal(savedConfig.data.configured, true);
  assert.equal(savedConfig.data.hasSecret, true);
  assert.equal(savedConfig.data.hasIceServers, true);
  assert.equal(JSON.stringify(savedConfig.data).includes("ci-only-company-secret"), false, "API must not return VoIP secrets in admin config");

  const agent1 = await createAgent(owner.token, "Agent One", "agent1@realdesk.test", "1001");
  const agent2 = await createAgent(owner.token, "Agent Two", "agent2@realdesk.test", "1002");
  const contact1 = await createContact(owner.token, "Alice", "+34910000001");
  const contact2 = await createContact(owner.token, "Bob", "+34910000002");
  const contact3 = await createContact(owner.token, "Charlie", "+34910000003");

  const csvCallbackAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const csvContent = [
    "firstName,lastName,phone,email,company,status,notes,doNotCall,callbackAt",
    "CSVImport,Test,+34919999997,csv-import@example.test,Imported Co,CALLBACK,Imported callback note,false," + csvCallbackAt
  ].join("\r\n");
  const csvForm = new FormData();
  csvForm.append("file", new Blob([csvContent], { type: "text/csv" }), "contacts.csv");
  const csvImported = await call("/api/contacts/import", { method: "POST", token: owner.token, form: csvForm, expected: 201 });
  assert.equal(csvImported.data.imported, 1);
  const contactsAfterImport = await call("/api/contacts", { token: owner.token });
  const importedContact = contactsAfterImport.data.find(contact => contact.phone === "+34919999997");
  assert.ok(importedContact, "CSV contact should be stored");
  assert.equal(importedContact.status, "CALLBACK");
  assert.equal(importedContact.notes, "Imported callback note");
  assert.equal(importedContact.callbackAt, csvCallbackAt);

  const campaign = (await call("/api/campaigns", {
    method: "POST",
    token: owner.token,
    expected: 201,
    body: { name: "Smoke Test Campaign", description: "CI-only synthetic contacts" }
  })).data;
  await call("/api/campaigns/" + campaign.id + "/contacts", {
    method: "POST", token: owner.token, body: { contactIds: [contact1.id], assignedTo: agent1.id }
  });
  await call("/api/campaigns/" + campaign.id + "/contacts", {
    method: "POST", token: owner.token, body: { contactIds: [contact2.id], assignedTo: agent2.id }
  });
  const campaignContacts = await call("/api/campaigns/" + campaign.id + "/contacts", { token: owner.token });
  assert.equal(campaignContacts.data.length, 2);

  const agentLogin = await login(agent1.email, "CI_Agent_Password_1001_9284!");
  assert.equal(agentLogin.user.role, "AGENT");
  const clientConfig = await call("/api/voip/client-config", { token: agentLogin.token });
  assert.equal(clientConfig.data.username, "1001", "agent-specific SIP credentials should override company credentials");
  assert.equal(clientConfig.data.password, "ci-only-sip-secret-1001");
  assert.equal(clientConfig.data.iceServers[1].credential, "turn-ci-password");
  await call("/api/voip/client-config", { token: owner.token, expected: 403 });

  const presence = await call("/api/agents/presence", {
    method: "PATCH", token: agentLogin.token, body: { presence: "AVAILABLE" }
  });
  assert.equal(presence.data.presence, "AVAILABLE");
  const presenceUsers = await call("/api/users", { token: owner.token });
  assert.equal(presenceUsers.data.find(u => u.id === agent1.id).presence, "AVAILABLE");
  await call("/api/agents/presence", {
    method: "PATCH", token: agentLogin.token, body: { presence: "ON_BREAK" }
  });
  await call("/api/agents/presence", { method: "PATCH", token: owner.token, expected: 403, body: { presence: "AVAILABLE" } });

  await call("/api/users/" + agent1.id, {
    method: "PATCH", token: owner.token,
    body: { sipUsername: "1001", sipDomain: "pbx.example.test", sipPassword: "rotated-ci-sip-secret" }
  });
  const rotatedConfig = await call("/api/voip/client-config", { token: agentLogin.token });
  assert.equal(rotatedConfig.data.password, "rotated-ci-sip-secret", "admin should be able to rotate SIP passwords");
  await call("/api/users/" + agent1.id, {
    method: "PATCH", token: owner.token, body: { clearSipCredentials: true }
  });
  const fallbackConfig = await call("/api/voip/client-config", { token: agentLogin.token });
  assert.equal(fallbackConfig.data.username, "company-test", "clearing an agent profile should fall back to company SIP");
  await call("/api/users/" + agent1.id, {
    method: "PATCH", token: owner.token,
    body: { sipUsername: "1001", sipDomain: "pbx.example.test", sipPassword: "ci-only-sip-secret-1001" }
  });
  await call("/api/users", { token: agentLogin.token, expected: 403 });

  const agentContacts = await call("/api/contacts", { token: agentLogin.token });
  assert.ok(agentContacts.data.some(c => c.id === contact1.id));
  assert.ok(!agentContacts.data.some(c => c.id === contact2.id), "agent must not see another agent's assigned campaign contact");
  await call("/api/contacts/" + contact2.id, { method: "PATCH", token: agentLogin.token, expected: 404, body: { notes: "must not edit" } });
  await call("/api/calls", { method: "POST", token: agentLogin.token, expected: 404, body: { contactId: contact2.id, direction: "OUTBOUND" } });

  // Call disposition changes contact status and the server blocks subsequent DNC calls.
  const call1 = (await call("/api/calls", {
    method: "POST", token: agentLogin.token, expected: 201,
    body: { contactId: contact1.id, direction: "OUTBOUND", recordingConsent: true }
  })).data;
  const finished1 = await call("/api/calls/" + call1.id + "/finish", {
    method: "PATCH", token: agentLogin.token,
    body: { disposition: "DO_NOT_CALL", notes: "CI disposition test", durationSec: 12, status: "COMPLETED" }
  });
  assert.equal(finished1.data.disposition, "DO_NOT_CALL");
  const updatedContact = await call("/api/contacts/" + contact1.id, { token: owner.token });
  assert.equal(updatedContact.data.status, "DO_NOT_CALL");
  assert.equal(updatedContact.data.doNotCall, true);
  await call("/api/calls", { method: "POST", token: agentLogin.token, expected: 403, body: { contactId: contact1.id, direction: "OUTBOUND" } });

  // Store a synthetic audio payload to prove encrypted storage and authorized playback.
  const audioBytes = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 17) % 256));
  const form = new FormData();
  form.append("file", new Blob([audioBytes], { type: "audio/webm" }), "ci-sample.webm");
  await call("/api/calls/" + call1.id + "/recording", {
    method: "POST", token: agentLogin.token, form, expected: 201
  });
  const recordings = await call("/api/recordings", { token: owner.token });
  assert.ok(recordings.data.some(r => r.id === call1.id));
  const playback = await call("/api/recordings/" + call1.id + "/audio", { token: agentLogin.token });
  assert.deepEqual(playback.data, audioBytes, "decrypted recording bytes should match the uploaded audio");
  const agent2Login = await login(agent2.email, "CI_Agent_Password_1002_9284!");
  await call("/api/recordings/" + call1.id + "/audio", { token: agent2Login.token, expected: 404 });

  const call2 = (await call("/api/calls", {
    method: "POST", token: agent2Login.token, expected: 201,
    body: { contactId: contact2.id, direction: "OUTBOUND" }
  })).data;
  await call("/api/calls/" + call2.id + "/finish", {
    method: "PATCH", token: agent2Login.token,
    body: { disposition: "WRONG_NUMBER", notes: "CI wrong number test", durationSec: 2, status: "COMPLETED" }
  });
  const wrongNumberContact = await call("/api/contacts/" + contact2.id, { token: owner.token });
  assert.equal(wrongNumberContact.data.status, "WRONG_NUMBER");
  await call("/api/calls", { method: "POST", token: agent2Login.token, expected: 403, body: { contactId: contact2.id, direction: "OUTBOUND" } });

  const callbackCall = (await call("/api/calls", {
    method: "POST", token: agentLogin.token, expected: 201,
    body: { contactId: contact3.id, direction: "OUTBOUND" }
  })).data;
  await call("/api/calls/" + callbackCall.id + "/finish", {
    method: "PATCH", token: agentLogin.token, expected: 400,
    body: { disposition: "CALLBACK_REQUESTED", notes: "callback missing time", durationSec: 10, status: "COMPLETED" }
  });
  const callbackAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await call("/api/calls/" + callbackCall.id + "/finish", {
    method: "PATCH", token: agentLogin.token,
    body: { disposition: "CALLBACK_REQUESTED", callbackAt, notes: "CI callback schedule test", durationSec: 10, status: "COMPLETED" }
  });
  const callbackContact = await call("/api/contacts/" + contact3.id, { token: owner.token });
  assert.equal(callbackContact.data.status, "CALLBACK");
  assert.ok(Math.abs(new Date(callbackContact.data.callbackAt).getTime() - new Date(callbackAt).getTime()) < 1000, "callback date/time should persist");

  const audit = await call("/api/audit", { token: owner.token });
  assert.ok(audit.data.some(event => event.action === "call.recording_played"));
  assert.ok(audit.data.some(event => event.action === "call.finished"));

  const oldAgent2Token = agent2Login.token;
  const changedPassword = await call("/api/auth/change-password", {
    method: "POST", token: oldAgent2Token,
    body: { currentPassword: "CI_Agent_Password_1002_9284!", newPassword: "CI_Agent_Password_1002_Rotated_9284!" }
  });
  assert.ok(changedPassword.data.token, "password change should return a new session token");
  await call("/api/contacts", { token: oldAgent2Token, expected: 401 });
  await call("/api/contacts", { token: changedPassword.data.token });
  const freshAgent2Login = await login("agent2@realdesk.test", "CI_Agent_Password_1002_Rotated_9284!");
  await call("/api/auth/logout", { method: "POST", token: freshAgent2Login.token });
  await call("/api/contacts", { token: freshAgent2Login.token, expected: 401 });

  console.log("RealDesk API smoke tests passed: company signup/isolation, login, roles, SIP secrets, ICE, campaign assignments, DNC/wrong-number, scheduled callbacks, encrypted recording upload/playback, password rotation, logout revocation, and audit log.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
