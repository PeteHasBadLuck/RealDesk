# VoIP setup

RealDesk uses a browser SIP client (JsSIP) with WebRTC media. This works only with a PBX/provider configured for browser calling; entering ordinary SIP credentials by itself does not make a provider WebRTC-compatible.

## Required provider capabilities

The company's PBX/provider must provide:

- SIP over secure WebSocket (`wss://...`) reachable from the browser
- WebRTC audio/media support for each agent extension
- A SIP user/extension and password per agent when possible
- An outbound dialing route that accepts the destination format RealDesk sends
- HTTPS for the RealDesk website
- Working NAT traversal: STUN and preferably TURN servers where direct WebRTC media connectivity does not work

The default STUN configuration is a public test fallback, not a production relay service. Many networks require TURN. RealDesk has an optional STUN/TURN JSON field in admin VoIP settings. TURN usernames and credentials are encrypted using `VOIP_ENCRYPTION_KEY`.

## Configure it

1. Configure the PBX first. Create an extension for each agent, enable WebSocket transport over TLS and WebRTC media, configure suitable codecs, and verify the PBX's firewall/RTP port ranges.
2. In **Admin portal → VoIP settings**, enter the provider name, SIP domain/realm, initial/company SIP username and password, WSS WebSocket URL, caller ID, and recording notice.
3. Add each call agent under **Admin portal → Users**. Prefer their individual SIP username, SIP domain, and password. Individual credentials are encrypted separately and override the company-level SIP credentials for that agent.
4. Add company STUN/TURN servers as JSON when needed. Example structure:

   ```json
   [
     { "urls": "stun:stun.example.net:3478" },
     { "urls": "turn:turn.example.net:3478", "username": "turn-user", "credential": "turn-password" }
   ]
   ```

   Replace the example hosts and credentials with values supplied by your provider/TURN administrator. Only configure a TURN username and credential when required by your TURN service.
5. Save the settings. On the agent desktop, click **Connect phone** and wait until it reports **Phone connected**. Then make a controlled test call to a number you are authorized to call.
6. Verify inbound ringing, answering, mute/unmute, end-of-call disposition, remote and local audio, recording playback, and call-log details. Test on the actual browsers and networks agents will use.

## Recording

Call recording is off by default. Set a company-approved recording notice before enabling it. Agents must explicitly confirm recording consent for each call before the browser starts capture. The application mixes WebRTC sender/receiver audio tracks and stores the resulting file encrypted on the configured persistent volume.

**Do not assume a recording is complete until you verify it contains both participants.** PBX behavior and browser track timing differ. Recording laws, notices, lawful basis, retention and deletion procedures vary by jurisdiction and call participants. Obtain legal/compliance approval before enabling recording for real calls.

## Provider compatibility

RealDesk is not tied to one carrier API. It expects SIP/WebRTC details compatible with JsSIP. A provider that offers only SIP username/password for a traditional phone or desk handset, but no WSS/WebRTC support, will need a compatible PBX/SBC, gateway, or provider adapter. Cloud telephony products that use their own REST tokens or SDK credentials may need a dedicated adapter rather than the SIP fields in this first version.
