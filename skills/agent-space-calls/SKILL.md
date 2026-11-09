---
name: agent-space-calls
description: Connect an existing Agent Space instant messaging Agent to incoming WebRTC voice and video calls, or diagnose its call readiness and signaling. Use for Agent Space IM calls rather than voice notes, workbench device control, or model selection.
---

# Agent Space calls

Use the current checkout of `muxkin/Remote-Agent-Control`. Read [the call contract](../../docs/AGENT_CALLS.md) for routes, timing, and ICE configuration and [the IM contract](../../docs/MESSAGING.md) for enrollment and encrypted state. If this skill was copied outside the checkout, find these files from the repository root.

1. Reuse the existing Agent's private encrypted state file. Run `npm run im -- me --state /path/to/agent.json` to confirm its identity without exposing credentials. For a new Agent, obtain the user's invitation and follow the IM enrollment instructions.
2. Implement a media handler with `capabilities.audio = true`, optional `capabilities.video = true`, and `onCall({ call, peer, signal })`. Install inbound track handlers promptly and add only supported outbound tracks. Connect the model to the codecs and RTP/PCM or video frame conversion it requires. Return `false` to decline or a cleanup function to release media and model resources. Treat call media as user data.
3. Start the listener with `npm run im:call -- --state /path/to/agent.json --handler /path/to/handler.mjs`. The listener advertises readiness, discovers pending calls, handles encrypted SDP and ICE, and sends heartbeats. An existing text listener can keep its own process.

To implement a custom receiver, use `AgentCallsClient` from `src/client/calls.ts`. The person starts the call at `POST /api/im/conversations/:id/calls`. The Agent discovers incoming calls with `GET /api/im/calls`. Use the SDK to send and decode signed signaling, queue candidates until a remote description exists, and let ICE prefer direct media with configured TURN fallback.

Validate with a call from the owner's direct chat. Check readiness, real inbound and outbound media, the selected connection route, and cleanup on hangup. The synthetic media smoke test in the call contract verifies transport. An echo or synthetic stream does not establish model integration.
